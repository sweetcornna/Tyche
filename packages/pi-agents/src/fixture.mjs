import { makeResult } from './protocol.mjs'

export function fixtureWorker(job) {
  const candidate = (asset) => ({
    schema: 'crypto_execution_candidate/v1',
    asset,
    product: 'usdm',
    symbol: `${asset}_USDT`,
    position_intent: 'ENTER_LONG',
    order_style: 'LIMIT',
    entry_price: 100,
    stop_price: 90,
    take_profit_price: 120,
    reduce_fraction_bps: null,
    data_as_of: `${job.date}T12:00:00.000Z`,
    anchor_week: job.isoWeek,
    anchor_fresh: true,
    thesis_invalidation: `${asset} fixture invalidation`,
    evidence_refs: [`fixture#${asset.toLowerCase()}`],
    signal_id: `fixture:${asset.toLowerCase()}`
  })
  const assetResult = (asset, withCandidate) => ({
    asset,
    symbol: `${asset}_USDT`,
    summary: `Fixture ${asset} analysis`,
    spot_bias: 'neutral',
    usdm_bias: 'neutral',
    invalidation: null,
    anchor_week: job.isoWeek,
    anchor_fresh: true,
    evidence_refs: [`asset.${asset}`],
    execution_candidates: withCandidate ? [candidate(asset)] : [],
    risks: []
  })
  const canonical = job.tier === 'weekly'
    ? {
        schema: 'tyche_weekly_strategy/v1',
        date: job.date,
        iso_week: job.isoWeek,
        generated_at: `${job.date}T12:00:00.000Z`,
        status: 'active',
        regime: { label: 'fixture' },
        assets: { BTC: assetResult('BTC', false), ETH: assetResult('ETH', false) },
        execution_candidates: [],
        blockers: [],
        risks: []
      }
    : {
        schema: 'tyche_crypto_daily/v1',
        date: job.date,
        iso_week: job.isoWeek,
        generated_at: `${job.date}T12:00:00.000Z`,
        anchored_week: job.isoWeek,
        anchor_fresh: true,
        regime: { label: 'fixture' },
        assets: { BTC: assetResult('BTC', true), ETH: assetResult('ETH', true) },
        execution_candidates: [candidate('BTC'), candidate('ETH')],
        blockers: [],
        risks: []
      }
  const output = job.role === 'orchestrator'
    ? { coordination: 'fixed-dag', allowed_roles: ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'], semantic_only: true }
    : job.role === 'preflight'
      ? { status: 'ready', evidence_refs: ['public.BTC', 'public.ETH'], blockers: [] }
      : job.role === 'btc-analyst'
      ? assetResult('BTC', job.tier === 'daily')
      : job.role === 'eth-analyst'
        ? assetResult('ETH', job.tier === 'daily')
        : job.role === 'synthesizer'
          ? canonical
          : structuredClone(job.input.synthesis || canonical)
  return makeResult(job, { status: 'ok', output })
}
