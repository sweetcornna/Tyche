"""Small text helpers shared across stages."""

from __future__ import annotations

import html
import re
import unicodedata
from functools import lru_cache

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# Only real markup: "<" immediately followed by a letter or "/", so "error < 5% when n > 100" survives.
_TAG = re.compile(r"</?[A-Za-z][^<>]{0,200}>")
_WS = re.compile(r"\s+")
# Markers that could be mistaken for instructions or for Tyche's own prompt
# delimiters when untrusted text (abstracts, web pages) is placed in a prompt.
_DELIMITER_LIKE = re.compile(r"</?\s*(?:system|assistant|user|instructions?|tyche[-_a-z]*)\s*>", re.I)


def sanitize_untrusted(text: str, limit: int | None = None) -> str:
    """Normalize third-party text before it enters a prompt or the paper.

    Removes control characters, markup, and anything shaped like a prompt
    delimiter, then collapses whitespace. The result is data, never
    instructions.
    """
    if not text:
        return ""
    cleaned = html.unescape(str(text))
    cleaned = _DELIMITER_LIKE.sub(" ", cleaned)
    cleaned = _TAG.sub(" ", cleaned)
    cleaned = _CONTROL.sub(" ", cleaned)
    cleaned = cleaned.replace("```", "'''")
    cleaned = _WS.sub(" ", cleaned).strip()
    if limit is not None and len(cleaned) > limit:
        cleaned = cleaned[: max(0, limit - 1)].rstrip() + "…"
    return cleaned


_GREEK = {
    "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ζ": "zeta", "η": "eta", "θ": "theta",
    "ι": "iota", "κ": "kappa", "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi", "π": "pi", "ρ": "rho", "σ": "sigma",
    "τ": "tau", "υ": "upsilon", "φ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega", "Γ": "Gamma", "Δ": "Delta",
    "Θ": "Theta", "Λ": "Lambda", "Ξ": "Xi", "Π": "Pi", "Σ": "Sigma", "Φ": "Phi", "Ψ": "Psi", "Ω": "Omega",
}
# Unicode that pdflatex cannot typeset directly. Math symbols use \ensuremath so the same
# replacement is valid inside and outside math mode.
LATEX_UNICODE: dict[str, str] = {
    "\u201c": "``", "\u201d": "''", "\u2018": "`", "\u2019": "'", "\u2032": "'",
    "\u2014": "---", "\u2013": "--", "\u2212": "-", "\u00a0": "~", "\u2026": r"\ldots{}",
    "\u00d7": r"\ensuremath{\times}", "\u00f7": r"\ensuremath{\div}", "\u2248": r"\ensuremath{\approx}",
    "\u2260": r"\ensuremath{\neq}", "\u2264": r"\ensuremath{\leq}", "\u2265": r"\ensuremath{\geq}",
    "\u2192": r"\ensuremath{\rightarrow}", "\u2190": r"\ensuremath{\leftarrow}", "\u2194": r"\ensuremath{\leftrightarrow}",
    "\u21d2": r"\ensuremath{\Rightarrow}", "\u00b1": r"\ensuremath{\pm}", "\u00b7": r"\ensuremath{\cdot}",
    "\u2022": r"\ensuremath{\bullet}", "\u00b5": r"\ensuremath{\mu}", "\u221e": r"\ensuremath{\infty}",
    "\u2208": r"\ensuremath{\in}", "\u2211": r"\ensuremath{\sum}", "\u221a": r"\ensuremath{\surd}",
    "\u00b0": r"\ensuremath{^\circ}", "\u2217": r"\ensuremath{\ast}", "\u2032\u2032": "''",
    "\u00b9": r"\textsuperscript{1}", "\u00b2": r"\textsuperscript{2}", "\u00b3": r"\textsuperscript{3}",
    **{char: "\\ensuremath{\\" + name + "}" for char, name in _GREEK.items()},
}


def _pdflatex_native(char: str) -> bool:
    """Characters pdflatex (utf8 inputenc, T1) typesets as-is: ASCII, Latin-1 letters, Latin Extended-A."""
    code = ord(char)
    return code < 128 or (0xC0 <= code <= 0x17F and char not in "\u00d7\u00f7")


def latex_unicode(text: str) -> tuple[str, list[str]]:
    """Map non-ASCII text to pdflatex-safe LaTeX; returns the text and characters that had to be dropped."""
    out: list[str] = []
    dropped: list[str] = []
    for char in text or "":
        if char in LATEX_UNICODE:
            out.append(LATEX_UNICODE[char])
        elif _pdflatex_native(char):
            out.append(char)
        else:
            folded = unicodedata.normalize("NFKD", char)
            kept = "".join(c for c in folded if _pdflatex_native(c) and not unicodedata.combining(c))
            if not kept:
                dropped.append(char)
            out.append(kept)
    return "".join(out), dropped


def normalize_title(title: str) -> str:
    folded = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode("ascii")
    folded = re.sub(r"[^a-z0-9 ]+", " ", folded.lower())
    return _WS.sub(" ", folded).strip()


def ascii_fold(text: str) -> str:
    return unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")


def slugify(text: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_fold(text).lower()).strip("-")
    return (slug[:max_len].rstrip("-")) or "run"


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-]*", text or ""))


@lru_cache(maxsize=1)
def _encoder():
    try:
        import tiktoken

        return tiktoken.get_encoding("cl100k_base")
    except Exception:  # noqa: BLE001 - tokenizer is optional; fall back to a heuristic
        return None


def count_tokens(text: str) -> int:
    """Approximate token count, used for context budgets rather than billing."""
    if not text:
        return 0
    encoder = _encoder()
    if encoder is not None:
        try:
            return len(encoder.encode(text, disallowed_special=()))
        except Exception:  # noqa: BLE001
            pass
    return max(1, len(text) // 4)


def truncate_tokens(text: str, budget: int) -> str:
    if count_tokens(text) <= budget:
        return text
    encoder = _encoder()
    if encoder is not None:
        tokens = encoder.encode(text, disallowed_special=())
        return encoder.decode(tokens[: max(0, budget - 1)]) + "…"
    return text[: max(0, budget * 4 - 1)] + "…"


def latex_escape(text: str) -> str:
    """Escape plain text (titles, author names) for safe inclusion in LaTeX."""
    replacements = {
        "\\": r"\textbackslash{}",
        "&": r"\&",
        "%": r"\%",
        "$": r"\$",
        "#": r"\#",
        "_": r"\_",
        "{": r"\{",
        "}": r"\}",
        "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}",
    }
    out = []
    for char in text or "":
        out.append(replacements.get(char, char))
    return "".join(out)
