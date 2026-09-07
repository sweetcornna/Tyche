# Tyche 3D 工作台

视觉沿用 OpenDesign 生成的深灰面板、矿物绿强调色与斜向构图；3D 使用错位叠片和无反光平涂材质。工作流模型与 BTC/ETH 图形
均为本项目原创 Blender 资产，无下载的模型、远程贴图或额外解码服务。

OpenDesign 原型、设计规范和样式源文件保存在 `docs/opendesign`；生产实现保留现有 React 状态及 API，只迁移视觉结构。

## 使用与重建

按 README 构建并启动控制平面即可使用。聊天前显示工作流主视觉，聊天后
收为顶部紧凑面板。“持仓”查看 Paper 状态，“详情”打开有键盘焦点约束的
原生对话框，Escape 关闭并返回展开按钮。界面只保留字段、操作与状态，数值标签使用 HTML，关闭动画或
3D 加载失败时仍可阅读全部数据。每页最多挂载一个 WebGL 画布。

资产源文件为 `assets/3d/tyche-console.blend`，包含两个根对象 `Workflow`、
`Trading`，六个 `agent_<role>` 节点和两个 `asset_<symbol>` 模块。
`Idle` 是循环动画，`Reveal` 是单次展开。使用 Blender 5.1 或更新版本重建：

```sh
blender --background --factory-startup --python assets/3d/build_scene.py
npm run web:build
```

脚本输出自包含 GLB 和两个透明 PNG 海报到 `apps/web/public/models`。
预览图关闭工作站路径元数据。GLB 为 176,404 字节、2,204 个三角面；测试
限制为 3 MiB、5,000 个三角面，并验证节点、动画、全部材质使用 unlit 扩展和无外部纹理依赖。
Three.js 固定为 0.185.1，独立延迟加载；桌面像素比最多 1.5、窄屏最多 1，
渲染循环最多 40 FPS，离屏与后台暂停，卸载释放材质、几何体与环境纹理。
动画暂停与系统减少动态效果偏好都会卸载画布，改用海报。

## Paper 场景接口

`GET /api/paper/scene` 使用现有会话与 Host/Origin 校验，不接受查询参数。
只有完整脚本控制平面绑定固定账本读取器；独立 package CLI 没有该适配器
时返回 `unavailable`。读取不会创建账户、写入账本或调用交易所。

| 字段 | 含义 |
| --- | --- |
| `schema`, `environment`, `status` | 固定 v1 场景与 Paper 环境；ready/unconfigured/invalid/unavailable |
| `dataset_id`, `revision`, `sequence` | 不暴露账户 ID 的数据集标识、版本与账本高水位 |
| `events_start_sequence` | 返回的原始账本尾窗起点；识别断档，不要求展示事件序号连续 |
| `updated_at`, `valuation_at` | 最新账本事件时间、最近完整核算时间，ISO UTC |
| `summary` | 当前余额、可用余额、占用保证金、已实现盈亏及最近核算权益/浮盈亏 |
| `positions` | 最多两个持仓；方向、合约张数、均价、保证金、保护价格与核算值 |
| `orders` | 最多二十个活动模拟订单；总数量与确认成交数量分别表示 |
| `events` | 最近五十条原始事件中的白名单展示事件，稳定 ID/序号/类型与有限标量 |

金融数值保持十进制字符串，文字显示不经过浮点四舍五入。当前数量来自
`derivePaperState`。核算状态按最近 `SIMULATED_EQUITY_MARK` 的账本前缀和
marks 重建，之后数量、方向或仓位身份改变时，不给新仓位套用旧价格。
缺失核算为 `null`，界面显示“待核算”。持仓环的长度表示占用保证金占比，
仅用于视觉展示；绝不参与下单计算。

首次读取、数据集变化、恢复可见和错误恢复均建立基线；重复/倒序响应不
重播成交。尾窗发生断档只同步当前快照。组件展开、折叠或暂停后恢复也
共享已消费事件集合。错误保留带过期标识的上次已知数据，不当作空仓。

## 验证

```sh
npm run check
npm test
npm run web:build
```

单元与接口测试覆盖部分成交后撤销余量、多空估值、旧核算不匹配、减仓、
平仓、强平、事件去重/断档、坏账本、符号链接、鉴权、凭据脱敏和资源 MIME。

可启动**完全隔离的视觉验收服务器**：

```sh
node apps/web/test/scene-preview.mjs
```

使用该命令打印的本地地址和测试 token 登录。它只使用内存中的测试账本，
不读取实际账户、不写账本、不连接模型网关。若需验证聊天，可填写示例
地址 `https://models.example.test/v1` 和任意测试 key，选择手动模型分配并
保存默认六角色，再运行 workflow。夹具演示 BTC 减仓、重新挂单、3/5 张
部分成交和余量撤销；“浅色”“深色”消息验证主题切换。停止进程即销毁夹具。

页面验收截图保存在 `docs/visual-qa`，截图中的持仓均为隔离夹具数据。
