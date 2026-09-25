"""Deterministic clean-up of model-written LaTeX before it is compiled.

Models produce small, predictable LaTeX mistakes: Markdown emphasis, stray
section commands, unescaped ``%``/``&``/``_``/``#`` in prose, Unicode
punctuation, and citations to keys that do not exist. This module repairs the
mechanical ones and reports the rest, so compile failures are rare and every
removed citation is visible in the gate report.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

_CITE = re.compile(r"\\(cite[tp]?|citealp|citeauthor|citeyear)\*?(\[[^\]]*\])?\{([^}]*)\}")
_SECTION = re.compile(r"^\s*\\(?:section|chapter)\*?\{[^}]*\}\s*$", re.M)
_MD_HEADING = re.compile(r"^\s*#{1,6}\s+(.*)$", re.M)
_MD_BOLD = re.compile(r"\*\*(.+?)\*\*")
_MD_ITALIC = re.compile(r"(?<![\*\w])\*(?!\s)([^*\n]+?)\*(?!\w)")
_MD_CODE = re.compile(r"`([^`\n]+)`")

_UNICODE = {
    "\u201c": "``",
    "\u201d": "''",
    "\u2018": "`",
    "\u2019": "'",
    "\u2014": "---",
    "\u2013": "--",
    "\u2026": r"\ldots{}",
    "\u00d7": r"$\times$",
    "\u2248": r"$\approx$",
    "\u2264": r"$\leq$",
    "\u2265": r"$\geq$",
    "\u2192": r"$\rightarrow$",
    "\u2190": r"$\leftarrow$",
    "\u00b1": r"$\pm$",
    "\u2212": "-",
    "\u00a0": "~",
    "\u2032": "'",
    "\u00b7": r"$\cdot$",
    "\u2022": r"$\bullet$",
    "\u03b1": r"$\alpha$",
    "\u03b2": r"$\beta$",
    "\u03b3": r"$\gamma$",
    "\u03b4": r"$\delta$",
    "\u0394": r"$\Delta$",
    "\u03bb": r"$\lambda$",
    "\u03c4": r"$\tau$",
    "\u03b8": r"$\theta$",
    "\u03c3": r"$\sigma$",
    "\u03bc": r"$\mu$",
}

_MATH_ENVS = ("equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray")
_VERBATIM_ENVS = ("tabular", "tabular*", "array", "verbatim", "lstlisting")


@dataclass
class SanitizeReport:
    removed_citations: list[str] = field(default_factory=list)
    fixes: list[str] = field(default_factory=list)


def _replace_unicode(text: str, report: SanitizeReport) -> str:
    out = []
    changed = False
    for char in text:
        if char in _UNICODE:
            out.append(_UNICODE[char])
            changed = True
        elif ord(char) < 128:
            out.append(char)
        else:
            folded = unicodedata.normalize("NFKD", char).encode("ascii", "ignore").decode("ascii")
            out.append(folded)
            changed = True
    if changed:
        report.fixes.append("replaced non-ASCII characters")
    return "".join(out)


def _escape_text_specials(text: str, report: SanitizeReport) -> str:
    """Escape % & _ # in text mode; leave math, tabular, and command arguments alone."""
    out: list[str] = []
    i = 0
    n = len(text)
    math_stack: list[str] = []
    env_depth = 0
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
            m = re.match(r"\\(label|ref|eqref|cref|Cref|autoref|url|href|cite[tp]?|citealp|includegraphics)\*?(\[[^\]]*\])?\{[^}]*\}", text[i:])
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
        if not in_math and ch in "%&#_":
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
    cleaned = re.sub(r"\s+([.,;:])", r"\1", cleaned) if report.removed_citations else cleaned
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
