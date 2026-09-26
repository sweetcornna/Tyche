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


def test_number_gate_catches_signed_ranges_units_and_headings():
    values = lambda t: [x[0] for x in numeric_tokens(t)]  # noqa: E731
    assert values("accuracy changes by $-99.9$ points") == ["-99.9"]
    assert values("the CI spans 1.0--99.9\\%") == ["1.0", "99.9"]
    assert values("7.9x faster, 13.5ms, and 12.5xyz") == ["7.9", "13.5"]
    assert values("\\paragraph{Ours reaches 99.9\\% accuracy.} Details.") == ["99.9"]
    assert values("a 2048-token context and 2000 items, as in 2023 (Smith, 2021)") == ["2048", "2000"]
    assert values("\\begin{minipage}{0.48\\linewidth} $3\\times 10^{-4}$, Section~4.2, $x_{12}$") == []
    assert values("GPT-4o, Llama-3.1-70B, top-10, \\citep[e.g.,][]{k_2023}") == []


def test_signed_numbers_must_match_the_sign_and_thresholds_are_registered():
    reg = NumberRegistry()
    reg.add(-12.34, "diff")
    assert reg.match("-12.3") is not None and reg.match("12.3") is not None  # a magnitude may be stated unsigned
    assert reg.match("-99.9") is None
    reg.add_text_numbers("We use 1,319 problems and a 12{,}000-token budget.", "design")
    assert reg.match("1319") is not None and reg.match("12000") is not None


def test_placeholder_gate_ignores_ordinary_words():
    assert check_placeholders({"method": "We insert the retrieved facts into a todo list."}) == []
    assert check_placeholders({"method": "INSERT RESULTS HERE"})


def test_sanitizer_keeps_latex_quotes_maps_unicode_and_escapes_table_cells():
    raw = ("``oracle'' and `greedy' with `code_span`; A \u2260 B, 3.2 \u00b5s, x\u00b2, $3 \u00d7 4$, "
           "\u03b1 = 0.05.\n\\begin{tabular}{lc}\ngpt_4o & 85.2% \\\\\n\\end{tabular}\n"
           "See \\citep[e.g.,][]{ok_1} and \\Citet{bad} \\input{sections/x_y}.")
    body, report = sanitize_section(raw, {"ok_1"})
    assert "``oracle'' and `greedy'" in body and "\\texttt{code\\_span}" in body
    assert "\\ensuremath{\\neq}" in body and "\\ensuremath{\\mu}s" in body and "\\textsuperscript{2}" in body
    assert "$3 \\ensuremath{\\times} 4$" in body and "\\ensuremath{\\alpha} = 0.05" in body
    assert "gpt\\_4o & 85.2\\%" in body
    assert "\\citep[e.g.,][]{ok_1}" in body and "\\input{sections/x_y}" in body
    assert report.removed_citations == ["bad"] and cited_keys(body) == ["ok_1"]


@needs_latex
def test_sanitized_unicode_heavy_section_compiles(tmp_path):
    from tyche.paper.latex import PaperSource, compile_pdf, write_build

    body, _ = sanitize_section(
        "Error drops \u2265 5% (A \u2260 B, 3.2 \u00b5s, x\u00b2, $3 \u00d7 4$, \u03b1 = 0.05, Nguy\u1ec5n, \u4e2d).", set()
    )
    bib = tmp_path / "refs.bib"
    bib.write_text("@misc{k1, title={A}, author={B, C}, year={2024}}\n")
    src = PaperSource(title="U", abstract="A.", sections={"introduction": body}, ai_statement="S.", reproducibility="R.")
    result = compile_pdf(write_build(src, tmp_path / "b", bib_path=bib, figures=[]))
    assert result.ok, result.errors


def test_reflection_reaches_result_sections_only(memory, tmp_path):
    from tyche.llm import ScriptedLLM
    from tyche.paper.writer import SectionWriter, WritingContext
    from tyche.planning import ResearchPlan
    from tyche.selftest import PLAN

    ctx = WritingContext(
        plan=ResearchPlan.model_validate(PLAN),
        citations=[],
        synthesis={},
        results_brief="- proposed accuracy 0.70",
        design_excerpt="design",
        labels={},
        run_id="r1",
        reflection_excerpt="Verdict: mixed; the latest-wins baseline was defective.",
    )
    writer = SectionWriter(
        ScriptedLLM({}),
        memory=memory,
        contracts={},
        budget=9000,
        evidence_limit=4,
        lessons_limit=2,
        manifest_dir=tmp_path / "manifests",
    )

    def names(section):
        return [b.name for b in writer._blocks(section, ctx, {}, None, None)]

    assert "experiment_reflection" in names("analysis")
    assert "experiment_reflection" in names("abstract")
    assert "experiment_reflection" not in names("method")
    assert "experiment_reflection" not in names("related_work")
