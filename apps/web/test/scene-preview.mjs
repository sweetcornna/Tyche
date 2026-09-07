// Local, deterministic visual QA. All orders live in memory; no gateway or ledger writes.
import path from 'node:path'
import readline from 'node:readline'
import { derivePaperState } from '../../../scripts/paper-trade.mjs'
import { fileURLToPath } from 'node:url'
import { createControlPlane, PROVIDER_MODELS } from '../../control-plane/src/control-plane.mjs'
import { projectPaperScene } from '../../../scripts/control-paper-scene.mjs'
import { sceneFixture } from '../../../test/paper-scene-fixtures.mjs'

const f = sceneFixture()
f.fill(f.open('BTC_USDT', 'buy', '2'), '2')
f.fill(f.open('ETH_USDT', 'sell', '10'), '10')
f.mark()
let dag = {}, cycle = { status: 'idle' }, sceneStatus = 'ready'
const roles = ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer']
const service = createControlPlane({
  port: 8799, bootstrapToken: 'tyche-scene-review', reusableBootstrapToken: true,
  staticRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
  discovery: { lookup: async () => [{ address: [8, 8, 8, 8].join('.'), family: 4 }], fetchImpl: async () => new Response(JSON.stringify({ object: 'list', data: [{ id: PROVIDER_MODELS[0] }] }), { headers: { 'content-type': 'application/json' } }) },
  adapters: {
    status: () => ({ service: 'ready' }), cycle: () => cycle, dag: () => ({ daily: dag }), paper: () => ({ status: 'paper-only' }),
    paperScene: () => sceneStatus === 'ready' ? projectPaperScene(f.ledger) : { status: sceneStatus },
    paperSetupStatus: () => ({ ready: true, status: 'ready', values: { initial_usdt: '10000' }, missing: [] }),
    validateProviderConfig: () => ({ ok: true }),
    discussStrategy: async ({ message, allocationRequested }, runtime) => {
      if (allocationRequested) return { intent: 'configure', apply_fields: ['suggested_role_models', 'suggested_role_efforts'], suggested_role_models: Object.fromEntries(roles.map((role) => [role, PROVIDER_MODELS[0]])), suggested_role_efforts: Object.fromEntries(roles.map((role) => [role, role === 'preflight' ? 'medium' : role === 'reviewer' ? 'xhigh' : 'high'])), allocation_reasons: Object.fromEntries(roles.map((role) => [role, '使用隔离测试目录内支持的模型与强度。'])), reply: '六个角色已完成分配。' }
      if (message.includes('慢速')) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 15000)
        runtime.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
      })
      if (message.includes('浅色')) return { intent: 'configure', apply_fields: ['theme'], theme: 'light', reply: '已切换为浅色主题。' }
      if (message.includes('深色')) return { intent: 'configure', apply_fields: ['theme'], theme: 'night', reply: '已切换为深色主题。' }
      if (message.includes('表格') || message.includes('代码')) return { intent: 'explain', reply: ['当前模拟持仓如下：', '', '| 资产 | 方向 | 合约数量 |', '| :--- | :--- | ---: |', '| BTC | ↑ 多仓 | 2 |', '| ETH | ↓ 空仓 | 10 |', '', '查看持仓时，优先核对 **数量、方向与核算时间**。', '', '```js', 'const symbols = ["BTC", "ETH"]', 'symbols.forEach(symbol => inspectPosition(symbol))', '```', '', '这段代码仅作格式展示。'] .join('\n') }
      return { intent: 'explain', reply: '已收到。当前展示 BTC 多仓与 ETH 空仓的隔离测试数据。可以打开持仓面板查看详情。' }
    },
    runCycle: async () => {
      cycle = { status: 'running' }; dag = {}
      for (const role of roles) {
        dag[role] = 'running'; service.publish({ type: 'dag_role', data: { role, status: 'running' } })
        await new Promise((resolve) => setTimeout(resolve, 700))
        dag[role] = 'complete'; service.publish({ type: 'dag_role', data: { role, status: 'complete' } })
      }
      f.close('BTC_USDT', derivePaperState(f.ledger).positions.BTC_USDT.contracts)
      const order = f.open('BTC_USDT', 'buy', '5')
      await new Promise((resolve) => setTimeout(resolve, 1800))
      f.fill(order, '3', true)
      await new Promise((resolve) => setTimeout(resolve, 1800))
      f.append('SIMULATED_CANCELLED', { paper_order_id: order, symbol: 'BTC_USDT', reason: 'VISIBLE_DEPTH_EXHAUSTED' }); f.mark()
      cycle = { status: 'complete', outcome: 'paper_applied', ok: true }
      return cycle
    }
  }
})
const info = await service.start()
process.stdout.write(`Isolated Paper visual QA: ${info.origin}\nToken: tyche-scene-review\n`)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (['ready', 'invalid', 'unavailable', 'unconfigured'].includes(line.trim())) { sceneStatus = line.trim(); process.stdout.write(`Scene fixture: ${sceneStatus}\n`) }
})
process.on('SIGTERM', () => service.stop().then(() => process.exit(0)))
process.on('SIGINT', () => service.stop().then(() => process.exit(0)))
