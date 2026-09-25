"""Deterministic clean-up of model-written LaTeX before it is compiled.

Models produce small, predictable LaTeX mistakes: Markdown emphasis, stray
section commands, unescaped ``%``/``&``/``_``/``#`` in prose, Unicode
punctuation, and citations to keys that do not exist. This module repairs the
mechanical ones and reports the rest, so compile failures are rare and every
removed citation is visible in the gate report.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from tyche.textutil import latex_unicode

_CITE = re.compile(r"\\([Cc]ite(?:t|p|alp|alt|author|year|num)?)\*?((?:\[[^\]]*\]){0,2})\{([^}]*)\}")
_SECTION = re.compile(r"^\s*\\(?:section|chapter)\*?\{[^}]*\}\s*$", re.M)
_MD_HEADING = re.compile(r"^\s*#{1,6}\s+(.*)$", re.M)
_MD_BOLD = re.compile(r"\*\*(.+?)\*\*")
_MD_ITALIC = re.compile(r"(?<![\*\w])\*(?!\s)([^*\n]+?)\*(?!\w)")
# Markdown code spans, but never LaTeX quotes (``like this'' or `this').
_MD_CODE = re.compile(r"(?<!`)`(?!`)([^`'\n]+)`(?![`'])")


_MATH_ENVS = (
    "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "array",
)
_VERBATIM_ENVS = ("verbatim", "lstlisting")
_ALIGN_ENVS = ("tabular", "tabular*", "tabularx")
# Commands whose brace argument is an identifier or path, copied without escaping.
_IDENTIFIER_CMD = re.compile(
    r"\\(?:label|ref|eqref|cref|Cref|autoref|url|href|input|include|includegraphics|"
    r"[Cc]ite(?:t|p|alp|alt|author|year|num)?)\*?(?:\[[^\]]*\]){0,2}\{[^}]*\}"
)


@dataclass
class SanitizeReport:
    removed_citations: list[str] = field(default_factory=list)
    fixes: list[str] = field(default_factory=list)


def _replace_unicode(text: str, report: SanitizeReport) -> str:
    converted, dropped = latex_unicode(text)
    if converted != text:
        report.fixes.append("mapped non-ASCII characters to LaTeX")
    if dropped:
        report.fixes.append("dropped characters pdflatex cannot typeset: " + "".join(sorted(set(dropped)))[:40])
    return converted


def _escape_text_specials(text: str, report: SanitizeReport) -> str:
    """Escape % & _ # in text mode; in tabular cells escape all but &; leave math and identifiers alone."""
    out: list[str] = []
    i = 0
    n = len(text)
    math_stack: list[str] = []
    env_depth = 0
    align_depth = 0
    escaped = 0
    while i < n:
        ch = text[i]
        if ch == "\\":
            # Environment tracking for math and alignment environments.
            m = re.match(r"\\(begin|end)\{([^}]+)\}", text[i:])
            if m:
                env = m.group(2)
                if env in _MATH_ENVS or env in _VERBATIM_ENVS:
                    env_depth += 1 if m.group(1) == "begin" else -1
                    env_depth = max(env_depth, 0)
                elif env in _ALIGN_ENVS:
                    align_depth += 1 if m.group(1) == "begin" else -1
                    align_depth = max(align_depth, 0)
                out.append(m.group(0))
                i += len(m.group(0))
                continue
            if text.startswith("\\(", i) or text.startswith("\\[", i):
                math_stack.append(text[i : i + 2])
                out.append(text[i : i + 2])
                i += 2
                continue
            if text.startswith("\\)", i) or text.startswith("\\]", i):
                if math_stack:
                    math_stack.pop()
                out.append(text[i : i + 2])
                i += 2
                continue
            # Copy a control word or control symbol verbatim, including its brace
            # arguments for commands whose arguments are identifiers.
            m = _IDENTIFIER_CMD.match(text, i)
            if m:
                out.append(m.group(0))
                i += len(m.group(0))
                continue
            out.append(text[i : i + 2])
            i += 2
            continue
        if ch == "$":
            if text.startswith("$$", i):
                if math_stack and math_stack[-1] == "$$":
                    math_stack.pop()
                else:
                    math_stack.append("$$")
                out.append("$$")
                i += 2
                continue
            if math_stack and math_stack[-1] == "$":
                math_stack.pop()
            else:
                math_stack.append("$")
            out.append(ch)
            i += 1
            continue
        in_math = bool(math_stack) or env_depth > 0
        specials = "%#_" if align_depth > 0 else "%&#_"
        if not in_math and ch in specials:
            out.append("\\" + ch)
            escaped += 1
            i += 1
            continue
        out.append(ch)
        i += 1
    if escaped:
        report.fixes.append(f"escaped {escaped} special characters in text mode")
    result = "".join(out)
    if math_stack:
        # Unbalanced inline math is a common model error; close it at the end.
        result += "$" * sum(1 for m in math_stack if m == "$")
        report.fixes.append("closed unbalanced inline math")
    return result


def filter_citations(text: str, allowed: set[str], report: SanitizeReport) -> str:
    def repl(match: re.Match[str]) -> str:
        command, opt, keys = match.group(1), match.group(2) or "", match.group(3)
        kept = []
        for key in (k.strip() for k in keys.split(",")):
            if not key:
                continue
            if key in allowed:
                kept.append(key)
            else:
                report.removed_citations.append(key)
        if not kept:
            return ""
        return f"\\{command}{opt}{{{','.join(kept)}}}"

    cleaned = _CITE.sub(repl, text)
    if report.removed_citations:
        cleaned = re.sub(r"[ \t]+([.,;:])", r"\1", cleaned)
        cleaned = re.sub(r"(?<=\S)[ \t]{2,}(?=\S)", " ", cleaned)
    return cleaned


_ENV_LINE = re.compile(r"\\(begin|end)\{([^}]+)\}")


def _convert_italics(body: str) -> str:
    """Turn Markdown *emphasis* into \\emph, never inside math or tabular material."""
    out = []
    depth = 0
    for line in body.split("\n"):
        protected = depth > 0
        for kind, env in _ENV_LINE.findall(line):
            if env in _MATH_ENVS or env in _VERBATIM_ENVS:
                if kind == "begin":
                    depth += 1
                    protected = True
                else:
                    depth = max(0, depth - 1)
                    protected = True
        if protected or "$" in line or "\\[" in line or "\\(" in line or "^*" in line:
            out.append(line)
        else:
            out.append(_MD_ITALIC.sub(r"\\emph{\1}", line))
    return "\n".join(out)


def sanitize_section(text: str, allowed_keys: set[str]) -> tuple[str, SanitizeReport]:
    report = SanitizeReport()
    body = text.strip()
    if _SECTION.search(body):
        body = _SECTION.sub("", body)
        report.fixes.append("removed section commands (the assembler adds them)")
    body = re.sub(r"\\begin\{document\}|\\end\{document\}|\\maketitle", "", body)
    if _MD_HEADING.search(body):
        body = _MD_HEADING.sub(lambda m: r"\paragraph{" + m.group(1).strip().rstrip(".") + ".}", body)
        report.fixes.append("converted Markdown headings")
    if "**" in body:
        body = _MD_BOLD.sub(r"\\textbf{\1}", body)
        report.fixes.append("converted Markdown bold")
    body = _convert_italics(body)
    body = _MD_CODE.sub(r"\\texttt{\1}", body)
    body = _replace_unicode(body, report)
    body = _escape_text_specials(body, report)
    body = filter_citations(body, allowed_keys, report)
    body = re.sub(r"\n{3,}", "\n\n", body).strip() + "\n"
    return body, report


def cited_keys(text: str) -> list[str]:
    keys: list[str] = []
    for match in _CITE.finditer(text):
        for key in match.group(3).split(","):
            key = key.strip()
            if key and key not in keys:
                keys.append(key)
    return keys
