import { Agent } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import {
  errorCode,
  errorMessage,
  makeResult,
  validateJob,
  validateSemanticOutput
} from './protocol.mjs'

export const SUBMIT_ANALYSIS_TOOL_NAME = 'submit_analysis'
export const SUBMIT_ANALYSIS_PARAMETERS = Type.Object({
  analysis: Type.Object({}, { additionalProperties: true })
}, { additionalProperties: false })

const ROLE_INSTRUCTIONS = Object.freeze({
  orchestrator: 'Return a read-only coordination context for the fixed DAG. You may not add roles, tools, branches, retries, or execution actions.',
  preflight: 'Check that the supplied dated public BTC/ETH evidence is present and coherent for downstream analysis. Return only a read-only preflight context; never persist files or make network/execution decisions.',
  'btc-analyst': 'Analyze only the supplied BTC asset evidence. Return semantic BTC bias, thesis, risks, and (for daily only) semantic candidates. Weekly output must contain zero candidates.',
  'eth-analyst': 'Analyze only the supplied ETH asset evidence. Return semantic ETH bias, thesis, risks, and (for daily only) semantic candidates. Weekly output must contain zero candidates.',
  synthesizer: 'Combine the preflight and two asset analyses into one complete canonical Tyche weekly or daily document. Weekly execution_candidates must be empty. Daily candidates may contain semantic action and entry/stop/target fields only; never add execution-owned sizing or identity fields.',
  reviewer: 'Review the synthesized canonical document against its dated weekly/daily contract. If accepted, return the complete canonical document unchanged, including all assets, candidates, blockers, and risks; never return only an acknowledgement or status summary.'
})

export function promptForJob(job) {
  return [
    `You are the Tyche ${job.role} analysis worker for ${job.tier} ${job.date} (${job.isoWeek}).`,
    ROLE_INSTRUCTIONS[job.role],
    'Produce semantic analysis only. Do not choose quantities, notional, leverage, client identifiers, reduce-only behavior, execution methods, hosts, paths, signatures, accounts, plans, ledgers, fills, or credentials. Semantic action and entry/stop/target fields are allowed only where the role instruction permits them.',
    'You have exactly one tool: submit_analysis. Call it exactly once with an object-valued analysis field. Do not call any other tool and do not write files.',
    `Input JSON:\n${JSON.stringify(job.input)}`
  ].join('\n\n')
}

function submitAnalysisTool(capture) {
  return {
    name: SUBMIT_ANALYSIS_TOOL_NAME,
    label: 'Submit analysis',
    description: 'Submit one semantic Tyche analysis object. This is the only available tool.',
    parameters: SUBMIT_ANALYSIS_PARAMETERS,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      const output = validateSemanticOutput(params.analysis)
      if (capture.value !== null) throw new Error('PI_DUPLICATE_SUBMIT_ANALYSIS')
      capture.value = output
      return {
        content: [{ type: 'text', text: 'Semantic analysis accepted.' }],
        details: { accepted: true },
        terminate: true
      }
    }
  }
}

function resolveModelAndStream(job, options) {
  if (options.model && typeof options.streamFn === 'function') return { model: options.model, streamFn: options.streamFn }
  if (options.model && !options.streamFn) {
    const models = options.models || builtinModels()
    return { model: options.model, streamFn: models.streamSimple.bind(models) }
  }
  const models = options.models || builtinModels()
  const model = models.getModel(job.provider, job.model)
  if (!model) throw new Error(`PI_MODEL_NOT_CONFIGURED:${job.provider}/${job.model}`)
  return { model, streamFn: models.streamSimple.bind(models) }
}

export async function runPiAgentJob(inputJob, options = {}) {
  const job = validateJob(inputJob)
  const startedAt = new Date().toISOString()
  const capture = { value: null }
  let unexpectedTool = null
  let agent
  let detachAbort = () => {}

  try {
    const { model, streamFn } = resolveModelAndStream(job, options)
    const tool = submitAnalysisTool(capture)
    agent = new Agent({
      initialState: {
        systemPrompt: 'Tyche semantic analysis worker. Use only the supplied input and submit_analysis.',
        model,
        thinkingLevel: 'off',
        tools: [tool]
      },
      streamFn,
      toolExecution: 'sequential',
      convertToLlm: (messages) => messages
    })
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'tool_execution_start' && event.toolName !== SUBMIT_ANALYSIS_TOOL_NAME) {
        unexpectedTool = event.toolName
        agent.abort()
      }
    })
    if (options.signal) {
      const abort = () => agent.abort()
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
      detachAbort = () => options.signal.removeEventListener('abort', abort)
    }
    await agent.prompt(promptForJob(job))
    unsubscribe()
    detachAbort()
    if (unexpectedTool) throw new Error(`PI_UNAUTHORIZED_TOOL:${unexpectedTool}`)
    if (capture.value === null) throw new Error('PI_ANALYSIS_NOT_SUBMITTED')
    return makeResult(job, {
      status: 'ok',
      output: capture.value,
      startedAt,
      finishedAt: new Date().toISOString()
    })
  } catch (error) {
    try { agent?.abort() } catch {}
    detachAbort()
    return makeResult(job, {
      status: 'error',
      code: errorCode(error),
      message: errorMessage(error),
      startedAt,
      finishedAt: new Date().toISOString()
    })
  }
}
