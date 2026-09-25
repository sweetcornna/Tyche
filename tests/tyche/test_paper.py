from tyche.analysis.registry import NumberRegistry
from tyche.gates.checks import check_citations, check_numbers, check_placeholders, check_structure, numeric_tokens, run_gates
from tyche.paper.latex import CompileResult, parse_log
from tyche.paper.sanitize import cited_keys, sanitize_section
from tyche.paper.statements import ai_use_statement, reproducibility_statement

from .conftest import needs_latex


def test_sanitizer_escapes_text_but_not_math_or_identifiers():
    raw = (
        "\\section{Intro}\n**Bold** 50% gain & more_stuff # x \\citep{ok2024a,bad2020} \\label{sec:a_b}\n"
        "\\begin{equation}\nv_{r^*} = a & b\n\\end{equation}\n\u201cq\u201d \u2014 $x_1$"
    )
    body, report = sanitize_section(raw, {"ok2024a"})
    assert "\\section" not in body
    assert "\\textbf{Bold} 50\\% gain \\& more\\_stuff \\# x" in body
    assert "\\label{sec:a_b}" in body and "v_{r^*} = a & b" in body and "$x_1$" in body
    assert "``q'' ---" in body
    assert cited_keys(body) == ["ok2024a"] and report.removed_citations == ["bad2020"]


def test_sanitizer_closes_unbalanced_math_and_drops_empty_citations():
    body, report = sanitize_section("value $x = 1 and \\citep{nope}.", set())
    assert body.count("$") % 2 == 0
    assert "\\citep" not in body and report.removed_citations == ["nope"]


def test_numeric_tokens_skip_identifiers_years_and_small_integers():
    tokens = numeric_tokens(
        "Accuracy 80.0\\% (95\\% CI 70.0 to 90.0) with 2{,}351 tokens in 2024, see \\ref{tab:1}, GPT-4 and 3 runs. % 99.9"
    )
    values = [t[0] for t in tokens]
    assert values == ["80.0", "95", "70.0", "90.0", "2351"]
    assert tokens[0][1] is True


def test_number_gate_flags_unregistered_numbers():
    reg = NumberRegistry()
    reg.add(0.8, "proposed.accuracy")
    reg.add(95, "confidence")
    ok = {"experiments": "We reach 80.0\\% accuracy (95\\% CI)."}
    bad = {"experiments": "We reach 83.5\\% accuracy."}
    assert check_numbers(ok, reg) == []
    [finding] = check_numbers(bad, reg)
    assert finding.severity == "blocker" and "83.5" in finding.message


def test_citation_and_structure_gates():
    sections = {
        "related_work": "Prior work \\citep{a} and Smith et al. (2021) studied this.",
        "introduction": "No list here.",
        "analysis": "Discussion without the required paragraph.",
    }
    findings, stats = check_citations(sections, {"a"}, 3, {"introduction": ["ghost"]})
    kinds = sorted((f.severity, f.gate) for f in findings)
    assert ("major", "citation") in kinds and ("minor", "citation") in kinds
    assert stats["related_work_citations"] == 1
    structure = check_structure(sections, {}, ["tab:main"])
    messages = " ".join(f.message for f in structure)
    assert "itemized contributions" in messages and "limitations" in messages and "tab:main" in messages
    assert check_placeholders({"method": "TODO: fill in ??"})


def test_run_gates_reports_page_limit_and_compile_errors():
    result = CompileResult(False, None, [], ["fig:x"], [], 0, 0)
    report = run_gates(
        sections={}, compile_result=result, main_pages=7, max_main_pages=5, registry=NumberRegistry(),
        bib_keys=set(), contracts={}, labels=[],
    )
    assert not report.passed
    assert any("limit is 5" in f.message for f in report.blockers)
    assert any("undefined reference" in f.message for f in report.blockers)


def test_parse_log_extracts_file_line_errors_and_warnings():
    log = (
        "./sections/method.tex:5: Missing { inserted.\n"
        "LaTeX Warning: Reference `tab:x' on page 2 undefined on input line 3.\n"
        "Package natbib Warning: Citation `k1' on page 1 undefined on input line 9.\n"
        "Overfull \\hbox (3.0pt too wide) in paragraph\n"
    )
    errors, refs, cites, overfull = parse_log(log)
    assert errors[0].file == "sections/method.tex" and errors[0].line == 5
    assert refs == ["tab:x"] and cites == ["k1"] and overfull == 1


def test_statements_are_truthful_about_the_engine():
    fixture = ai_use_statement({"models": ["m"], "experiment_engine": "fixture"}, "Team reviewed.")
    assert "not experimental results" in fixture and "Team reviewed." in fixture
    real = ai_use_statement({"models": ["deepseek"], "experiment_engine": "openjiuwen"}, "")
    assert "openJiuwen" in real
    assert "synthetic" in reproducibility_statement({"experiment_engine": "fixture", "analysis_seed": 1})


@needs_latex
def test_minimal_iclr_document_compiles(tmp_path):
    from tyche.paper.latex import PaperSource, compile_pdf, main_text_pages, write_build

    bib = tmp_path / "refs.bib"
    bib.write_text("@misc{k1, title={A}, author={B, C}, year={2024}}\n")
    src = PaperSource(
        title="Tiny", abstract="An abstract.", sections={"introduction": "Hello \\citep{k1}."},
        ai_statement="AI statement.", reproducibility="Repro.",
    )
    result = compile_pdf(write_build(src, tmp_path / "b", bib_path=bib, figures=[]))
    assert result.ok, result.errors
    assert result.pages >= 1 and not result.undefined_citations
    assert main_text_pages(result.pdf) == 1
