# Spec-Tackle

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/spectacles-dark.svg">
    <img src="docs/spectacles-light.svg" width="370" alt="A pair of spectacles on a page of diff lines; through the lenses the page reads as a clean document">
  </picture>
</p>

A reviewer-oriented reading view for GitHub pull requests, built for spec and design-doc PRs.

```bash
uvx --from git+https://github.com/dimagi/spec-tackle spec-tackle
```

Opens `http://127.0.0.1:8765`. It authenticates with `GITHUB_TOKEN`/`GH_TOKEN`, or falls back to `gh auth token`. If you're not signed in, the page offers **Sign in with GitHub** (via the GitHub CLI) or lets you paste a token.

## What you get

- **Readable document**: markdown is rendered as a page with a serif body, an outline and scroll-spy. Diagrams in Mermaid code blocks are drawn as diagrams. Images work in private repos too. Code and other non-markdown files show as diffs.
- **Comments in the margin**: review threads sit next to the passage they discuss, and that passage is highlighted. Click either one to focus the other.
- **Comment anywhere**: hover a block and click **+**, or select text and press **c**. Comments post straight to the PR as review comments. If the text didn't change in the PR, GitHub won't accept a line comment there, so the composer says so and posts a file comment that names the lines.
- **Reply, resolve or reopen** threads. Reply drafts are saved locally.
- **Light / dark / system theme** toggle in the top bar (defaults to light, remembered per browser).
- **Live**: the page checks GitHub every 30 seconds. New comments are flagged and announced, and the tab title shows an unread count. You're told when new commits land.
- **Reviewer tools**: Open/All filter, hide bot comments, open-thread counts per section, `j`/`k` to jump between open threads, and a **Finish review** button (Comment / Approve / Request changes).
- **Modified specs**: changed blocks get a green marker, with a **Document ↔ Changes** toggle.

## Development

```bash
uv run pytest
```

FastAPI + Jinja (`src/spec_tackle/app.py`), GitHub GraphQL/REST client (`github.py`), markdown→line-mapped HTML (`render.py`), vanilla JS UI with Tailwind (`static/`).
