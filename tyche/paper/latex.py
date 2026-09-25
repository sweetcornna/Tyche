"""Assemble and compile the ICLR 2027 document; read back what the PDF shows."""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path

from tyche.textutil import latex_escape

TEMPLATE_FILES = (
    "iclr2027_conference.sty",
    "iclr2027_conference.bst",
    "math_commands.tex",
    "fancyhdr.sty",
    "natbib.sty",
)

# Numbered main-text sections in reading order, with their headings.
MAIN_SECTIONS: tuple[tuple[str, str], ...] = (
    ("introduction", "Introduction"),
    ("related_work", "Related Work"),
    ("method", "Method"),
    ("experiments", "Experiments"),
    ("analysis", "Analysis and Discussion"),
    ("conclusion", "Conclusion"),
)
AI_STATEMENT_HEADING = "AI use statement"


@dataclass
class PaperSource:
    title: str
    abstract: str
    sections: dict[str, str]
    ai_statement: str
    reproducibility: str
    floats: dict[str, str] = field(default_factory=dict)  # section name -> float LaTeX placed at its start
    authors: list[dict[str, str]] = field(default_factory=list)
    anonymous: bool = True
    appendix: str = ""
    method_heading: str = "Method"


def _author_block(authors: list[dict[str, str]]) -> str:
    if not authors:
        return r"\author{Anonymous authors \\ Paper under double-blind review}"
    parts = []
    for author in authors:
        lines = [latex_escape(author.get("name", ""))]
        for key in ("affiliation", "email"):
            if author.get(key):
                value = latex_escape(author[key])
                lines.append(r"\texttt{" + value + "}" if key == "email" else value)
        parts.append(r" \\ ".join(lines))
    return r"\author{" + r" \And ".join(parts) + "}"


def main_tex(src: PaperSource) -> str:
    lines = [
        r"\documentclass{article}",
        r"\usepackage{iclr2027_conference,times}",
        r"\input{math_commands.tex}",
        r"\usepackage[utf8]{inputenc}",
        r"\usepackage[T1]{fontenc}",
        r"\usepackage{hyperref}",
        r"\usepackage{url}",
        r"\usepackage{booktabs}",
        r"\usepackage{graphicx}",
        r"\usepackage{amsmath,amssymb}",
        r"\usepackage{xcolor}",
        r"\hypersetup{colorlinks=true,linkcolor=red!55!black,citecolor=blue!55!black,urlcolor=blue!55!black}",
        "",
        r"\title{" + latex_escape(src.title) + "}",
        _author_block([] if src.anonymous else src.authors),
    ]
    if not src.anonymous:
        lines.append(r"\iclrfinalcopy")
    lines += [
        r"\begin{document}",
        r"\maketitle",
        "",
        r"\begin{abstract}",
        r"\input{sections/abstract}",
        r"\end{abstract}",
        "",
    ]
    for name, heading in MAIN_SECTIONS:
        if name not in src.sections:
            continue
        heading = src.method_heading if name == "method" else heading
        lines.append(r"\section{" + latex_escape(heading) + r"}\label{sec:" + name + "}")
        if name in src.floats:
            lines.append(r"\input{sections/" + name + "_floats}")
        lines.append(r"\input{sections/" + name + "}")
        lines.append("")
    lines += [
        r"\subsection*{" + AI_STATEMENT_HEADING + "}",
        r"\input{sections/ai_statement}",
        "",
        r"\subsection*{Reproducibility statement}",
        r"\input{sections/reproducibility}",
        "",
        r"\bibliography{refs}",
        r"\bibliographystyle{iclr2027_conference}",
    ]
    if src.appendix.strip():
        lines += ["", r"\appendix", r"\input{sections/appendix}"]
    lines += [r"\end{document}", ""]
    return "\n".join(lines)


def write_build(src: PaperSource, build_dir: Path, *, bib_path: Path, figures: list[Path]) -> Path:
    build_dir.mkdir(parents=True, exist_ok=True)
    sections_dir = build_dir / "sections"
    sections_dir.mkdir(exist_ok=True)
    for name in TEMPLATE_FILES:
        data = resources.files("tyche.paper.template").joinpath(name).read_bytes()
        (build_dir / name).write_bytes(data)
    (sections_dir / "abstract.tex").write_text(src.abstract.strip() + "\n", encoding="utf-8")
    for name, body in src.sections.items():
        (sections_dir / f"{name}.tex").write_text(body.strip() + "\n", encoding="utf-8")
    for name, floats in src.floats.items():
        (sections_dir / f"{name}_floats.tex").write_text(floats.strip() + "\n", encoding="utf-8")
    (sections_dir / "ai_statement.tex").write_text(src.ai_statement.strip() + "\n", encoding="utf-8")
    (sections_dir / "reproducibility.tex").write_text(src.reproducibility.strip() + "\n", encoding="utf-8")
    if src.appendix.strip():
        (sections_dir / "appendix.tex").write_text(src.appendix.strip() + "\n", encoding="utf-8")
    shutil.copy2(bib_path, build_dir / "refs.bib")
    fig_dir = build_dir / "figures"
    fig_dir.mkdir(exist_ok=True)
    for fig in figures:
        shutil.copy2(fig, fig_dir / fig.name)
    tex = build_dir / "main.tex"
    tex.write_text(main_tex(src), encoding="utf-8")
    return tex


@dataclass
class LatexError:
    file: str
    line: int | None
    message: str


@dataclass
class CompileResult:
    ok: bool
    pdf: Path | None
    errors: list[LatexError]
    undefined_references: list[str]
    undefined_citations: list[str]
    overfull_boxes: int
    pages: int
    log_tail: str = ""


_FILE_LINE_ERR = re.compile(r"^(\./[^:\n]+|[^:\n]+\.tex):(\d+): (.+)$", re.M)
_BANG_ERR = re.compile(r"^! (.+)$", re.M)
_UNDEF_REF = re.compile(r"Reference `([^']+)' on page \d+ undefined")
_UNDEF_CITE = re.compile(r"Citation `([^']+)' on page \d+ undefined")


def parse_log(log: str) -> tuple[list[LatexError], list[str], list[str], int]:
    errors: list[LatexError] = []
    for match in _FILE_LINE_ERR.finditer(log):
        errors.append(LatexError(match.group(1).lstrip("./"), int(match.group(2)), match.group(3).strip()))
    if not errors:
        for match in _BANG_ERR.finditer(log):
            errors.append(LatexError("", None, match.group(1).strip()))
    refs = sorted(set(_UNDEF_REF.findall(log)))
    cites = sorted(set(_UNDEF_CITE.findall(log)))
    overfull = len(re.findall(r"^Overfull \\hbox", log, re.M))
    return errors, refs, cites, overfull


def latex_available() -> dict[str, str | None]:
    return {tool: shutil.which(tool) for tool in ("latexmk", "pdflatex", "bibtex", "pdftotext", "pdfinfo")}


def pdf_pages(pdf: Path) -> int:
    try:
        out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    match = re.search(r"^Pages:\s+(\d+)", out, re.M)
    if match:
        return int(match.group(1))
    try:
        import pypdfium2

        return len(pypdfium2.PdfDocument(str(pdf)))
    except Exception:  # noqa: BLE001
        return 0


def compile_pdf(tex: Path, *, timeout: int = 180) -> CompileResult:
    build = tex.parent
    for stale in build.glob("main.*"):
        if stale.suffix in {".aux", ".bbl", ".blg", ".fdb_latexmk", ".fls", ".out", ".log", ".pdf"}:
            stale.unlink()
    cmd = [
        "latexmk",
        "-pdf",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        tex.name,
    ]
    try:
        proc = subprocess.run(cmd, cwd=build, capture_output=True, text=True, timeout=timeout)
        returncode = proc.returncode
    except FileNotFoundError:
        return CompileResult(False, None, [LatexError("", None, "latexmk is not installed")], [], [], 0, 0)
    except subprocess.TimeoutExpired:
        return CompileResult(False, None, [LatexError("", None, f"latexmk timed out after {timeout}s")], [], [], 0, 0)
    log_path = build / "main.log"
    log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else proc.stdout
    errors, refs, cites, overfull = parse_log(log)
    pdf = build / "main.pdf"
    ok = returncode == 0 and pdf.exists() and not errors
    if returncode != 0 and not errors:
        errors = [LatexError("", None, (proc.stdout + proc.stderr)[-800:] or "latexmk failed")]
    return CompileResult(
        ok=ok,
        pdf=pdf if pdf.exists() else None,
        errors=errors,
        undefined_references=refs,
        undefined_citations=cites,
        overfull_boxes=overfull,
        pages=pdf_pages(pdf) if pdf.exists() else 0,
        log_tail=log[-2000:],
    )


def pdf_page_texts(pdf: Path) -> list[str]:
    """Text of each page, via pdftotext (layout mode)."""
    try:
        out = subprocess.run(
            ["pdftotext", "-layout", str(pdf), "-"], capture_output=True, text=True, timeout=60
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        out = ""
    if out:
        pages = out.split("\f")
        return pages[:-1] if pages and not pages[-1].strip() else pages
    try:
        import pypdfium2

        doc = pypdfium2.PdfDocument(str(pdf))
        return [doc[i].get_textpage().get_text_range() for i in range(len(doc))]
    except Exception:  # noqa: BLE001
        return []


def pdf_text(pdf: Path) -> str:
    return "\n\f\n".join(pdf_page_texts(pdf))


def main_text_pages(pdf: Path) -> int:
    """Pages of main text: everything before the AI use statement (ICLR's page-limit convention)."""
    pages = pdf_page_texts(pdf)
    for index, page in enumerate(pages, start=1):
        if AI_STATEMENT_HEADING.lower() in page.lower():
            lines = [ln.strip() for ln in page.splitlines() if ln.strip()]
            body = [ln for ln in lines if not ln.lower().startswith("under review as") and not ln.lower().startswith("published as")]
            if body and body[0].lower().startswith(AI_STATEMENT_HEADING.lower()):
                return index - 1
            return index
    return len(pages)
