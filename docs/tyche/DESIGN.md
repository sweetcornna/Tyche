# Tyche 设计说明

本文说明 Tyche 各阶段的输入、输出与判定规则，便于复现审核与答辩。代码位置均相对仓库根目录。

## 1. 设计目标

1. **结果可追溯**：论文中的文献、数字、图表都能追溯到检索记录、实验日志与统计脚本。
2. **失败要显式**：证据不足时停止并说明原因，而不是生成“看起来合理”的内容。
3. **分数导向但不作弊**：以 Stanford Agentic Reviewer 公开的 7 个评审维度组织自评与修订，但只通过改写提高清晰度、证据支撑与定位，不伪造实验。
4. **复用 openJiuwen 能力**：实验自动化、模型接入、上下文压缩与技能演进格式都来自 JiuwenSwarm / agent-core，Tyche 只补齐它们缺少的环节。

## 2. 运行目录与溯源

`workspace/runs/<run-id>/` 下：

| 路径 | 内容 |
|---|---|
| `state.json` | 各阶段状态（pending/running/done/failed）、题目、方向、配置摘要 |
| `events.jsonl` | 追加式事件日志（阶段开始/结束、产物保存、评审轮次、引用增补等） |
| `provenance.jsonl` | 每个产物版本一行：名称、版本、路径、SHA-256、产生阶段、输入、父版本 |
| `artifacts/<name>/v<N>.*` | 不可变的产物版本；重复保存生成新版本 |
| `usage.jsonl` | 每次模型调用的阶段、用途、token 数与时延 |
| `write/context_manifests/` | 每次写作调用的上下文装配清单（纳入/截断/丢弃的块及 token 数、引用的记忆条目） |
| `review/` | 每轮构建目录、评审 JSON、台账、轮次记录 |
| `package/` | 最终交付物 |

`tyche run --resume` 从第一个未完成阶段继续；`--stage X` 可单独重跑某一阶段。打包时重新计算全部产物的哈希，任何改动都会记录在 `provenance.json` 的 `drifted_artifacts` 中。

## 3. 各阶段

### S0 规划（`tyche/planning.py`）

输入为题目、方向预设（`tyche/configs/directions/*.yaml`）、记忆中已生效的写作经验以及可选的人工备注。输出 `ResearchPlan`：研究问题（1–3 个）、假设及可测预测、方法名与机制、基线、实验族、任务、指标、贡献、范围限制、检索式。模型输出经 pydantic 校验，失败时带着校验错误重问，最多 3 次。

### S1 文献调研（`tyche/literature/`）

1. 模型基于计划与方向种子查询生成检索式，并与计划中的检索式合并去重（最多 `literature.max_queries` 条）。
2. 对 arXiv（Atom API）、Semantic Scholar Graph API、OpenAlex 逐一检索。按主机限速，429/5xx 指数退避重试，响应缓存到 SQLite。
3. 方向预设中的经典工作名通过标题检索解析，标题相似度 ≥ 0.88 才接受。
4. 按 arXiv 编号、DOI、S2 编号、规范化标题去重合并；以 BM25（标题加权）加引用数与时效先验做预排序。
5. 模型逐批阅读标题与摘要，给出 0–3 相关度与角色（baseline/mechanism/benchmark/analysis/background）。
6. 对前几篇论文沿 S2 引文图向前、向后各扩展一跳，新候选同样筛选。
7. **核验**：需具备标题、作者、年份与至少一个持久标识；非 arXiv 来源的 arXiv 编号回查 arXiv，DOI 回查 Crossref；标题不符即判定矛盾并排除。
8. **证据卡**：模型为每篇论文写 1–2 条观点，每条必须附摘要中的逐字引文（≥ 20 字符），代码逐字比对，不符即丢弃。
9. 模型把已核验论文归纳为 2–4 个主题，并写出研究空白；主题中的论文编号若不在集合内会被剔除。

输出 `refs.bib`（只含核验通过的记录）、`research_summary.md`（含 auto_research 可解析的 `## Short Summary / ## Key Findings / ## Open Problems`）、`source-manifest.json`、`candidate-pool.json`。

### S2 实验（`tyche/experiments/bridge.py`）

默认引擎调用 openJiuwen `auto_research` 的 `ManagerRuntime`，模块开关为：`topic_survey=false`、`experiment_design / code_implementation / experiment_execution / reflection = true`、`reporting=false`。

- 研究输入：Tyche 的 `research_summary.md` 与研究计划，作为 `research_paths` 传入。
- 约束：短论文规模、至多 4 个变体、记录逐条目结果、禁止硬编码指标。
- 预算：回合数与重试次数更紧。
- 模型：生成的实验代码通过环境变量 `API_KEY / API_BASE / MODEL_NAME` 调用同一模型。

收集的产物包括各变体的 `results/*.metrics.json`、实验设计文档、生成代码与反思记录。

替代引擎：

- `imported`：读取团队自行产生的 `<variant>.metrics.json` 目录，可附 `design.md` 与 `code/`。
- `fixture`：只供离线自检使用的合成数据。

少于两个成功变体时阶段失败，不会进入写作。

### S3 分析（`tyche/analysis/`）

- **变体识别**：名为 `proposed`、或与方法名匹配、或含 `ours` 的变体被视为提出方法。
- **指标选取**：所有变体共有的数值指标（排除记账字段），按计划中的指标顺序排列。
- **逐条目统计**：若 `per_question` 中有同名字段，或布尔字段 `correct/success`，则计算均值、标准差与 95% percentile bootstrap 置信区间（默认 2000 次重采样）。
- **配对比较**：按条目编号对齐（无编号时按位置对齐），计算差值及其 bootstrap 置信区间、sign-flip 置换检验 p 值（默认 5000 次，加一校正）和相对变化。
- **方向判定**：名称含 token、cost、latency、error、stale、violation 等词的指标视为越低越好，最优值标注随之调整。
- **允许数字登记表**：登记上述所有数值（含百分比形式），以及实验设计与计划文档中出现的全部设置数字。
- **图表**：生成主结果表、配对比较表与带置信区间的柱状图。

### S4 写作（`tyche/paper/`）

- **写作顺序**：方法 → 实验 → 分析 → 相关工作 → 引言 → 结论 → 摘要，最后是标题。先写实质内容，再写框架性段落。
- **章节契约**：每节有目标、硬性要求与字数范围（`paper.sections`，面向 ≤ 5 页的短论文），例如引言以 2–4 条贡献列表结尾、相关工作每个主题一段且引用 ≥ 6 篇、分析必须包含 Limitations 段落、实验必须引用所有表图标签。
- **上下文装配**（`tyche/memory/context_pack.py`）：必选块包括章节契约、研究计划、允许的引用列表、结果简报与可用标签；可选块包括实验设计摘录、调研综述、按检索相关度选取的证据卡、生效的写作经验以及已写章节的摘要。装配在 `memory.context_budgets.section` 预算内进行，可选块按优先级纳入，放不下的截断，清单落盘。
- **确定性清洗**（`sanitize.py`）：去掉模型自带的 `\section`；将 Markdown 转为 LaTeX；替换 Unicode 标点；在正文模式下转义 `% & _ #`（不进入数学、tabular 与标识符参数）；补全未闭合的行内公式；删除不在允许列表中的引用键并记录。
- **组装与编译**：使用 ICLR 2027 官方样式、`natbib` 与 `iclr2027_conference.bst`，由 `latexmk -pdf` 编译。编译错误定位到具体章节文件，交给模型只修 LaTeX 问题（最多 3 次）；主文页数超限时按比例压缩最长的章节（最多 3 次）。主文页数以 “AI use statement” 标题出现的页为界，与 ICLR 的计页口径一致。
- **声明**：AI use statement 与 Reproducibility statement 由代码根据运行元数据生成，包括所用模型、实验引擎、随机种子与人工审阅声明。

### 门禁（`tyche/gates/checks.py`）

| 门禁 | 规则 | 严重度 |
|---|---|---|
| compile | 编译成功；无未定义引用、未定义文献；PDF 中无 `??` | blocker |
| number | 摘要/引言/实验/分析/结论中的每个数字（排除标识符参数、年份与 10 以下整数）须是登记值按其精度的四舍五入，或其百分比形式 | blocker |
| citation | 引用键必须存在于核验后的 bib；“X et al. (年份)” 附近必须有引用命令；相关工作引用篇数达标 | blocker / major |
| structure | 各章节齐全；引言有贡献列表；分析有局限性；所有表图被引用；字数在契约范围内；主文页数不超限 | blocker / major / minor |
| placeholder | 无 TODO/TBD/XXX/`??`/[citation needed] 等残留 | blocker |

### S5 评审与修订（`tyche/review/`）

- **评审团**：三位视角评审（rigor / positioning / clarity），各自按 7 个维度 1–10 分打分，并给出 ICLR 总评、置信度、优缺点与至多 8 条发现。每条发现须带章节、严重度、维度、论文原文逐字引文、问题、可通过改写完成的修改建议与关闭标准。评审只能要求改写，不能要求补做实验；证据不足时应收窄结论。
- **引文校验**：发现中的引文若在论文文本中找不到，严重度降一级；minor 级直接丢弃，以抑制幻觉式批评。
- **定位参照**：评审同时拿到检索到但未被引用的相关论文清单（R01…R15）。若评审点名要求讨论其中某篇，Tyche 先核验该论文，再把它加入 bib 与允许引用列表。
- **忠实度审计**：审计员对照结果简报与被引论文的证据，检查误引、夸大与遗漏的局限，只追溯、不重算。
- **台账**：每条发现有编号与生命周期（open → resolved / wontfix / unaddressed）。重复提出计为 re-flag，超过上限即关闭为 unaddressed。写作者须对每条发现回复 fixed 或 rebutted，下一轮评审逐条裁决。门禁问题以 `gate:*` 来源进入台账，门禁不再报告时自动关闭。
- **修订与接受**：只重写有待处理发现的章节（每轮至多 8 条），重新编译、过门禁、再评审。候选稿须编译成功、阻断项不增加且综合分下降不超过容差，才会被接受，否则回滚。达到目标分、连续无进步或到达轮数上限时停止，始终保留最佳稿。

综合分（composite）是 7 个维度的等权平均，只用于同一论文不同草稿间的比较。

### S6 演进（`tyche/evolution/playbook.py`）

模型把台账提炼为至多 6 条写作经验，每条包含类别、可执行的指导语、适用章节与来源发现编号。经验以 global 作用域存入记忆，状态机如下：

- **candidate**：首次出现。
- **active**：在至少 `promote_after_runs` 次运行中出现，且至少 `promote_after_helped` 条来源发现的修复被接受、分数未降。只有这一状态的经验会进入后续写作上下文。
- **retired**：处于 active 状态时已被注入写作上下文，但同类问题仍在 `retire_after_misses` 次运行中复现，说明指导无效。

生效经验导出为 JiuwenSwarm 技能 `evolutions.json` 格式（复用 `openjiuwen.agent_evolving` 的 `EvolutionLog / EvolutionRecord`），可在 JiuwenSwarm 中查看与回滚。

### S7 打包

门禁未通过时拒绝打包（`--allow-gate-failures` 可强制打包，但报告会标记 UNVERIFIED）。交付物为 `paper.pdf`、`paper_source/`、`provenance.json`、`review_ledger.json`、`gates.json`、`run_report.md`。

## 4. 与 JiuwenSwarm 的集成

- **模型**：`tyche/llm.py` 通过 `openjiuwen.core.foundation.llm.init_model` 接入，支持 JiuwenSwarm 支持的所有 OpenAI 兼容服务。
- **实验**：直接驱动 openJiuwen 的 `ManagerRuntime`，方式与 JiuwenSwarm 的 RSI paper provider 相同，但关闭了调研与报告模块。
- **蜂群编排**：技能 `tyche-iclr-paper` 以 SwarmFlow 脚本按阶段编排，每个阶段智能体只执行对应命令并汇报状态，支持 `human()` 人工审批计划。该技能通过了 JiuwenSwarm `swarmskill-creator` 的校验器。
- **Agent 模式**：技能 `tyche-paper` 提供对话式入口。
- **技能演进**：生效经验以 `evolutions.json` 格式导出。

## 5. 已知限制

- 自动实验的成败取决于 openJiuwen 实验智能体与所用模型的能力。遇到失败时，可以用 `--engine imported` 接入团队自己的实验。
- 评审团与 paperreview.ai 的评分模型不同。它能指出薄弱维度，但不能预测最终分数。
- 默认模型（如 DeepSeek）为纯文本模型，评审基于 PDF 抽取的文本与表格，不评价图像的视觉质量。
- 本仓库的离线测试不访问网络与真实模型；真实运行需要可访问的模型 API 与学术 API。
