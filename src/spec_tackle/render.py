"""Turn PR files into reviewer-friendly HTML where every block knows its source lines.

Every commentable element carries `data-ls` / `data-le` (1-based, inclusive line
range in the head version of the file). The browser uses those to place comment
threads next to the text they discuss and to post new comments on the right lines.
"""

from __future__ import annotations

import posixpath
import re
from html import escape, unescape
from urllib.parse import quote

from markdown_it import MarkdownIt
from mdit_py_plugins.front_matter import front_matter_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from pygments.lexers import get_lexer_by_name, guess_lexer_for_filename
from pygments.token import STANDARD_TYPES
from pygments.util import ClassNotFound

MARKDOWN_EXTENSIONS = (".md", ".markdown", ".mdx")

_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")


def is_markdown(path: str) -> bool:
    return path.lower().endswith(MARKDOWN_EXTENSIONS)


# -- diffs -----------------------------------------------------------------


def parse_patch(patch: str | None) -> tuple[list[tuple[int, int]], set[int]]:
    """Return (hunk ranges on the new side, added line numbers) for a unified patch."""
    hunks: list[tuple[int, int]] = []
    added: set[int] = set()
    if not patch:
        return hunks, added
    new_line = 0
    for row in patch.splitlines():
        match = _HUNK_RE.match(row)
        if match:
            start = int(match.group(3))
            length = int(match.group(4)) if match.group(4) is not None else 1
            if length:
                hunks.append((start, start + length - 1))
            new_line = start
        elif row.startswith("+"):
            added.add(new_line)
            new_line += 1
        elif row.startswith(" "):
            new_line += 1
    return hunks, added


def resolve_anchor(
    start: int, end: int, hunks: list[tuple[int, int]], whole_file: bool
) -> dict | None:
    """Map a line range onto something GitHub will accept as a review comment anchor.

    GitHub only allows line comments inside diff hunks, and a multi-line comment
    must sit within one hunk. Returns `{"line", "start_line"}` (clipped to the
    first overlapping hunk) or None when the range is not commentable at all.
    """
    if whole_file:
        return {"line": end, "start_line": start if start < end else None}
    for hunk_start, hunk_end in hunks:
        lo, hi = max(start, hunk_start), min(end, hunk_end)
        if lo <= hi:
            return {"line": hi, "start_line": lo if lo < hi else None}
    return None


def render_diff(patch: str, path: str) -> str:
    """Render a unified patch as a table; new-side lines are commentable."""
    lexer = _lexer_for(path)
    rows: list[str] = []
    old_line = new_line = 0
    for raw in patch.splitlines():
        match = _HUNK_RE.match(raw)
        if match:
            old_line, new_line = int(match.group(1)), int(match.group(3))
            rows.append(
                '<tr class="diff-hunk"><td colspan="3">'
                f"{escape(raw)}</td></tr>"
            )
            continue
        if raw.startswith("\\"):
            continue
        sign, text = raw[:1], raw[1:]
        code = _highlight_lines(text, lexer)[0]
        if sign == "-":
            rows.append(
                f'<tr class="diff-del"><td class="ln">{old_line}</td><td class="ln"></td>'
                f'<td class="code"><span class="sign">-</span>{code}</td></tr>'
            )
            old_line += 1
            continue
        kind = "diff-add" if sign == "+" else "diff-ctx"
        sign_html = "+" if sign == "+" else "&nbsp;"
        rows.append(
            f'<tr class="{kind}" data-ls="{new_line}" data-le="{new_line}">'
            f'<td class="ln">{"" if sign == "+" else old_line}</td>'
            f'<td class="ln">{new_line}</td>'
            f'<td class="code"><span class="sign">{sign_html}</span>{code}</td></tr>'
        )
        new_line += 1
        if sign != "+":
            old_line += 1
    return f'<table class="diff">{"".join(rows)}</table>'


# -- syntax highlighting ---------------------------------------------------


def _lexer_for(path_or_lang: str, is_lang: bool = False):
    # stripnl=False: Pygments otherwise drops leading blank lines, shifting every line number.
    try:
        if is_lang:
            return get_lexer_by_name(path_or_lang, stripnl=False)
        return guess_lexer_for_filename(path_or_lang, "", stripnl=False)
    except ClassNotFound:
        return None


def _highlight_lines(code: str, lexer) -> list[str]:
    """Highlight code, returning one HTML string per source line."""
    if lexer is None:
        return [escape(line) for line in code.split("\n")]
    lines: list[list[str]] = [[]]
    for token_type, value in lexer.get_tokens(code):
        css = STANDARD_TYPES.get(token_type) or STANDARD_TYPES.get(token_type.parent, "")
        for i, part in enumerate(value.split("\n")):
            if i:
                lines.append([])
            if part:
                lines[-1].append(f'<span class="{css}">{escape(part)}</span>' if css else escape(part))
    # Pygments always appends a trailing newline.
    if len(lines) > 1 and not lines[-1] and not code.endswith("\n"):
        lines.pop()
    return ["".join(parts) for parts in lines]


# -- markdown --------------------------------------------------------------


def render_markdown(
    text: str,
    *,
    path: str,
    raw_base: str,
    blob_base: str,
    added_lines: set[int] | None = None,
) -> str:
    """Render markdown with source line ranges on every block element.

    `raw_base` serves repo files (images) and `blob_base` links to GitHub for
    relative document links; both are joined with paths relative to the repo root.
    """
    added_lines = added_lines or set()
    md = (
        MarkdownIt("commonmark", {"html": False, "linkify": False, "typographer": True})
        .enable(["table", "strikethrough"])
        .use(front_matter_plugin)
        .use(tasklists_plugin)
    )
    file_dir = posixpath.dirname(path)

    def repo_path(target: str) -> str | None:
        if re.match(r"^([a-z][a-z0-9+.-]*:|#|//)", target, re.I):
            return None
        return posixpath.normpath(posixpath.join(file_dir, target.split("#")[0]))

    tokens = md.parse(text)
    for token in tokens:
        if token.nesting == 1 and token.map and not token.hidden:
            start, end = token.map[0] + 1, token.map[1]
            token.attrSet("data-ls", str(start))
            token.attrSet("data-le", str(end))
            if token.type != "table_open" and any(
                line in added_lines for line in range(start, end + 1)
            ):
                token.attrJoin("class", "is-changed")
        if token.type == "inline" and token.children:
            for child in token.children:
                if child.type == "image":
                    target = repo_path(child.attrGet("src") or "")
                    if target is not None:
                        child.attrSet("src", f"{raw_base}/{quote(target)}")
                elif child.type == "link_open":
                    href = child.attrGet("href") or ""
                    target = repo_path(href)
                    if target is not None:
                        anchor = "#" + href.split("#", 1)[1] if "#" in href else ""
                        child.attrSet("href", f"{blob_base}/{quote(target)}{anchor}")
                    if not href.startswith("#"):
                        child.attrSet("target", "_blank")
                        child.attrSet("rel", "noopener")

    renderer = md.renderer

    def render_fence(self, tokens, idx, options, env):
        token = tokens[idx]
        lang = (token.info or "").strip().split()[0] if token.info else ""
        first_line = token.map[0] + 2  # line after the opening fence
        content = token.content[:-1] if token.content.endswith("\n") else token.content
        block_range = f'data-ls="{token.map[0] + 1}" data-le="{token.map[1]}"'
        if lang == "mermaid":
            return (
                f'<div class="mermaid-block" {block_range}>'
                f'<pre class="mermaid">{escape(content)}</pre></div>'
            )
        lexer = _lexer_for(lang, is_lang=True) if lang else None
        lines = _highlight_lines(content, lexer)
        source_lines = content.split("\n")
        # --indent lets wrapped continuations hang under the line's own indentation.
        indents = [
            len(src) - len(src.lstrip(" \t")) if src.strip() else 0 for src in source_lines
        ]
        body = "".join(
            f'<span class="code-line{" is-changed" if first_line + i in added_lines else ""}"'
            f' style="--indent:{indents[i] if i < len(indents) else 0}"'
            f' data-ls="{first_line + i}" data-le="{first_line + i}">{line or " "}</span>'
            for i, line in enumerate(lines)
        )
        label = f'<span class="code-lang">{escape(lang)}</span>' if lang else ""
        return f'<div class="code-block" {block_range}>{label}<pre><code>{body}</code></pre></div>'

    def render_heading_open(self, tokens, idx, options, env):
        token = tokens[idx]
        title = tokens[idx + 1].content
        slug = _slugify(title, env.setdefault("slugs", {}))
        token.attrSet("id", f"{_slugify(path, {})}--{slug}")
        return self.renderToken(tokens, idx, options, env)

    def render_table_open(self, tokens, idx, options, env):
        return '<div class="table-wrap">' + self.renderToken(tokens, idx, options, env)

    def render_table_close(self, tokens, idx, options, env):
        return self.renderToken(tokens, idx, options, env) + "</div>"

    def render_code_inline(self, tokens, idx, options, env):
        # Let long paths and dotted names break after "/" and "." instead of
        # forcing their table column (or paragraph) wider than the page.
        body = re.sub(r"([/.])(?=.)", r"\1<wbr>", escape(tokens[idx].content))
        return f"<code{self.renderAttrs(tokens[idx])}>{body}</code>"

    renderer.rules["code_inline"] = render_code_inline.__get__(renderer)
    renderer.rules["table_open"] = render_table_open.__get__(renderer)
    renderer.rules["table_close"] = render_table_close.__get__(renderer)
    renderer.rules["fence"] = render_fence.__get__(renderer)
    renderer.rules["code_block"] = render_fence.__get__(renderer)
    renderer.rules["heading_open"] = render_heading_open.__get__(renderer)
    renderer.rules["front_matter"] = lambda *a, **k: ""
    return renderer.render(tokens, md.options, {})


def _slugify(text: str, seen: dict[str, int]) -> str:
    slug = re.sub(r"[^\w\- ]", "", text.lower()).strip().replace(" ", "-") or "section"
    count = seen.get(slug, 0)
    seen[slug] = count + 1
    return f"{slug}-{count}" if count else slug


# -- Claude answers ----------------------------------------------------------


def render_answer(text: str) -> str:
    """Render a Claude answer. It is untrusted (a PR can steer it), so: no raw HTML,
    images shown as text instead of loaded, links open in a new tab without a referrer."""
    md = MarkdownIt("commonmark", {"html": False, "linkify": False}).enable(["table", "strikethrough"])

    def image(self, tokens, idx, options, env):
        token = tokens[idx]
        return escape(f"{token.content} ({token.attrGet('src') or ''})")

    def fence(self, tokens, idx, options, env):
        token = tokens[idx]
        lang = (token.info or "").strip().split()[0] if token.info else ""
        lexer = _lexer_for(lang, is_lang=True) if lang else None
        code = token.content[:-1] if token.content.endswith("\n") else token.content
        return f'<pre class="code"><code>{"\n".join(_highlight_lines(code, lexer))}</code></pre>'

    md.add_render_rule("image", image)
    md.add_render_rule("fence", fence)
    tokens = md.parse(text)
    for token in tokens:
        for child in token.children or []:
            if child.type == "link_open":
                child.attrSet("target", "_blank")
                child.attrSet("rel", "noopener noreferrer")
    return md.renderer.render(tokens, md.options, {})


def outline(html: str) -> list[dict]:
    """Extract (level, id, text, line) for h1–h3 from rendered markdown."""
    pattern = re.compile(
        r'<h([1-3]) data-ls="(\d+)"[^>]*id="([^"]+)"[^>]*>(.*?)</h\1>', re.S
    )
    return [
        {
            "level": int(level),
            "line": int(line),
            "id": anchor,
            "text": unescape(re.sub(r"<[^>]+>", "", inner)),
        }
        for level, line, anchor, inner in pattern.findall(html)
    ]


# -- activity --------------------------------------------------------------


def _person(author: dict | None) -> dict:
    if not author:
        return {"login": "ghost", "avatarUrl": "", "isBot": False}
    is_bot = author.get("__typename") == "Bot" or author["login"].endswith("[bot]")
    return {"login": author["login"], "avatarUrl": author["avatarUrl"], "isBot": is_bot}


def normalize_activity(data: dict) -> dict:
    """Flatten GitHub's GraphQL shape into what the frontend renders."""
    threads = []
    for node in data["reviewThreads"]["nodes"]:
        comments = [
            {
                "id": c["databaseId"],
                "author": _person(c["author"]),
                "body": c.get("body") or "",
                "bodyHTML": c["bodyHTML"],
                "createdAt": c["createdAt"],
                "url": c["url"],
                "canEdit": bool(c.get("viewerCanUpdate")),
            }
            for c in node["comments"]["nodes"]
        ]
        if not comments:
            continue
        threads.append(
            {
                "id": node["id"],
                "path": node["path"],
                "line": node["line"],
                "startLine": node["startLine"],
                "originalLine": node["originalLine"],
                "originalStartLine": node["originalStartLine"],
                "isResolved": node["isResolved"],
                "isOutdated": node["isOutdated"],
                "isFileLevel": node["subjectType"] == "FILE",
                "side": node["diffSide"],
                "resolvedBy": (node.get("resolvedBy") or {}).get("login"),
                "comments": comments,
            }
        )

    conversation = [
        {
            "kind": "comment",
            "id": c["databaseId"],
            "author": _person(c["author"]),
            "body": c.get("body") or "",
            "bodyHTML": c["bodyHTML"],
            "createdAt": c["createdAt"],
            "url": c["url"],
            "canEdit": bool(c.get("viewerCanUpdate")),
        }
        for c in data["comments"]["nodes"]
    ]
    for review in data["reviews"]["nodes"]:
        has_body = bool(re.sub(r"<[^>]+>|\s", "", review["bodyHTML"] or ""))
        if review["state"] == "PENDING" or (review["state"] == "COMMENTED" and not has_body):
            continue
        conversation.append(
            {
                "kind": "review",
                "id": review["databaseId"],
                "state": review["state"],
                "author": _person(review["author"]),
                "body": (review.get("body") or "") if has_body else "",
                "bodyHTML": review["bodyHTML"] if has_body else "",
                "createdAt": review["submittedAt"],
                "url": review["url"],
                "canEdit": bool(review.get("viewerCanUpdate")),
            }
        )
    conversation.sort(key=lambda item: item["createdAt"] or "")

    return {
        "headSha": data["headRefOid"],
        "state": "MERGED" if data.get("merged") else data["state"],
        "isDraft": data["isDraft"],
        "viewer": data["viewer"],
        "threads": threads,
        "conversation": conversation,
    }
