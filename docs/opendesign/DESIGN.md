# Tyche OpenDesign redesign system

## 设计判断

本次重设计基于只读检查的 `App.jsx`、`styles.css`、`scene.css`、`SceneDock.jsx` 和两张 QA 截图。现有版本结构清楚，但视觉被过度留白和弱层级削平：左侧导航、中部对话、3D 场景和右侧设置之间缺少明确的比例关系，抽象场景更像装饰而不是运行状态的一部分。

新的方向保留 Tyche 的冷静工作台属性，用深灰金融控制台作为底，配一个克制的矿物绿强调色。设计感来自比例、斜向构图、面板深浅层次、密集但有秩序的中文信息，而不是靠高刺激题材或宣传式文案。

## Tokens

六个核心色彩 token：

```css
--bg: oklch(14% 0.018 245);
--surface: oklch(19% 0.016 245);
--fg: oklch(91% 0.012 230);
--muted: oklch(66% 0.015 230);
--border: oklch(30% 0.012 240);
--accent: oklch(72% 0.095 155);
```

字体：

```css
--font-display: "Aptos Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
--font-body: "Aptos", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
--font-mono: "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, monospace;
```

## Layout posture

- 三栏桌面骨架：左侧 232px 导航，中部对话流自适应，右侧 380px 场景与运行设置。
- 右侧 3D 不是背景装饰，而是承接工作流或持仓状态的运行面板。
- 桌面使用斜向承重构图：右侧场景板块略高，中部对话保持可读宽度。
- 移动端 390px 下改为单列：顶部品牌与主要视图切换、对话优先、场景/设置下沉。
- 圆角控制在 8px 内，边框和层次替代大投影。

## Interaction states

- `登录`、`工作流`、`持仓详情`、`设置` 是主视图，可在原型中直接切换。
- 支持深色/浅色主题切换，使用同一语义 token，不新增第二强调色。
- 工作流角色、场景模式、持仓资产、设置分组都可点击切换。
- 未配置、空持仓、未知金额、缺失模型统一显示 `—`，不虚构财务数值。

## React18 migration notes

- `index.html` 中的 `data-view`、`data-role`、`data-asset` 可直接映射为 React state。
- `tokens.css` 可复制到 `apps/web/src/tokens.css`，并在 `styles.css` 顶部引入。
- 组件边界建议对应现有工程：`AgentSidebar`、`ChatWorkspace`、`SceneDock`、`RunSettingsPanel`、`LoginScreen`。
- 视觉重构应优先替换 CSS 和 JSX 结构，不需要改动 API、workflow 或凭据处理逻辑。
