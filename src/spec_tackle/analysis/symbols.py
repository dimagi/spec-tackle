"""Which functions, classes, methods and attributes a change touches."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import Literal

Kind = Literal["function", "class", "method", "attribute", "module"]
Change = Literal["added", "modified", "removed"]
MODULE = "<module>"


@dataclass(frozen=True)
class Symbol:
    name: str
    kind: Kind
    change: Change
    signature_changed: bool
    lines: tuple[int, int]
    base_lines: tuple[int, int] | None = None


@dataclass(frozen=True)
class _Span:
    name: str
    kind: Kind
    start: int
    end: int
    signature: str | None


def _start(node: ast.AST) -> int:
    decorators = getattr(node, "decorator_list", [])
    return min([node.lineno, *(d.lineno for d in decorators)])


def _signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    return ast.dump(node.args) + "|" + "|".join(ast.dump(d) for d in node.decorator_list)


def _spans(tree: ast.Module) -> list[_Span]:
    """Every symbol, innermost last: a class comes before its methods and attributes."""
    spans: list[_Span] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            spans.append(_Span(node.name, "function", _start(node), node.end_lineno, _signature(node)))
        elif isinstance(node, ast.ClassDef):
            spans.append(_Span(node.name, "class", _start(node), node.end_lineno, None))
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    spans.append(_Span(f"{node.name}.{item.name}", "method", _start(item), item.end_lineno, _signature(item)))
                elif isinstance(item, (ast.Assign, ast.AnnAssign)):
                    targets = item.targets if isinstance(item, ast.Assign) else [item.target]
                    for t in targets:
                        if isinstance(t, ast.Name):
                            spans.append(_Span(f"{node.name}.{t.id}", "attribute", item.lineno, item.end_lineno, None))
    return spans


def _owner(spans: list[_Span], line: int) -> _Span | None:
    """The innermost symbol containing `line`."""
    found = None
    for s in spans:
        if s.start <= line <= s.end and (found is None or s.start >= found.start):
            found = s
    return found


def _touched(spans: list[_Span], lines: set[int]) -> tuple[dict[str, _Span], bool]:
    hit: dict[str, _Span] = {}
    module = False
    for line in lines:
        owner = _owner(spans, line)
        if owner:
            hit[owner.name] = owner
        else:
            module = True
    return hit, module


def changed_symbols(base_src: str | None, head_src: str | None, added: set[int], removed: set[int]) -> list[Symbol]:
    """Symbols touched by the patch. `added` are head lines, `removed` are base lines.

    With no base (GitHub sent no patch) nothing can be known to be removed or re-signed.
    """
    head = _spans(ast.parse(head_src)) if head_src else []
    try:
        base = _spans(ast.parse(base_src)) if base_src else []
    except SyntaxError:
        base_src, base = None, []
    head_by = {s.name: s for s in head}
    base_by = {s.name: s for s in base}
    head_hit, head_module = _touched(head, added)
    base_hit, base_module = _touched(base, removed) if base_src is not None else ({}, False)

    symbols: list[Symbol] = []
    for name in sorted(set(head_hit) | set(base_hit), key=lambda n: (head_by.get(n) or base_by[n]).start):
        h, b = head_by.get(name), base_by.get(name)
        if h and (b or base_src is None):
            change: Change = "modified"
        elif h:
            change = "added"
        else:
            change = "removed"
        span = h or b
        resigned = bool(h and b and h.signature is not None and h.signature != b.signature)
        symbols.append(Symbol(name, span.kind, change, resigned, (span.start, span.end), (b.start, b.end) if b else None))
    if head_module or base_module:
        symbols.insert(0, Symbol(MODULE, "module", "modified", False, (1, 1)))
    return symbols
