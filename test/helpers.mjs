import { loadConfig, validateConfig } from '../scripts/config.mjs'
import { createPlan } from '../scripts/gate-trade.mjs'

export const NOW = Date.parse('2030-01-07T12:00:00.000Z')
export const DATE = '2030-01-07'
export const WEEK = '2030-W02'

export function manualConfig() {
  const config = structuredClone(loadConfig())
  config.gate.submission_mode = 'manual_testnet'
  config.gate.usdm.environment = 'testnet'
  config.gate.usdm.configured_leverage = 2
  config.gate.usdm.risk_per_trade_bps = 25
  config.gate.usdm.max_order_notional_usdt = 100
  config.gate.usdm.daily_new_notional_cap_usdt = 200
  config.gate.usdm.max_managed_notional_usdt = 300
  validateConfig(config)
  return config
}

export function dailySource(overrides = {}) {
  const at = new Date(NOW).toISOString()
  const candidate = {
    schema: 'crypto_execution_candidate/v1',
    asset: 'BTC',
    product: 'usdm',
    symbol: 'BTC_USDT',
    position_intent: 'ENTER_LONG',
    order_style: 'LIMIT',
    entry_price: 100,
    stop_price: 90,
    take_profit_price: 120,
    reduce_fraction_bps: null,
    data_as_of: at,
    anchor_week: WEEK,
    anchor_fresh: true,
    thesis_invalidation: 'Synthetic test fixture',
    evidence_refs: ['fixture#btc'],
    signal_id: 'fixture:btc:long',
    ...(overrides.candidate || {})
  }
  return {
    schema: 'tyche_crypto_daily/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: at,
    anchored_week: WEEK,
    anchor_fresh: true,
    regime: { label: 'test_fixture' },
    assets: {},
    execution_candidates: [candidate],
    blockers: [],
    risks: [],
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'candidate'))
  }
}

export function weeklyAnchor(overrides = {}) {
  return {
    schema: 'tyche_weekly_strategy/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: new Date(NOW).toISOString(),
    status: 'active',
    regime: { label: 'test_fixture' },
    assets: { BTC: { spot_bias: 'long', usdm_bias: 'long' }, ETH: { spot_bias: 'neutral', usdm_bias: 'neutral' } },
    execution_candidates: [],
    ...overrides
  }
}

export function marketSnapshot(overrides = {}) {
  const levels = { fixture: { entry: 100, stop: 90, target: 120 } }
  return {
    schema: 'tyche_crypto_market/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: new Date(NOW).toISOString(),
    source: 'fixture',
    assets: {
      BTC: {
        symbol: 'BTC_USDT',
        spot: { ticker: { last: '100' }, technical: { daily: { level_sets: levels }, four_hour: { level_sets: {} } } },
        usdm: { ticker: { last: '100', mark_price: '100', index_price: '100' }, technical: { daily: { level_sets: levels }, four_hour: { level_sets: {} } } }
      },
      ETH: {
        symbol: 'ETH_USDT',
        spot: { ticker: {}, technical: { daily: { level_sets: {} }, four_hour: { level_sets: {} } } },
        usdm: { ticker: {}, technical: { daily: { level_sets: {} }, four_hour: { level_sets: {} } } }
      }
    },
    ...overrides
  }
}

export function planContext() {
  const at = new Date(NOW).toISOString()
  return {
    rules: {
      BTC_USDT: {
        name: 'BTC_USDT',
        order_price_round: '0.1',
        quanto_multiplier: '0.001',
        order_size_min: '1',
        order_size_max: '100000',
        leverage_max: '3',
        maintenance_rate: '0.005',
        maker_fee_rate: '-0.0001',
        taker_fee_rate: '0.0005',
        status: 'trading',
        in_delisting: false,
        _fetched_at: at
      }
    },
    quotes: { BTC_USDT: { product: 'usdm', symbol: 'BTC_USDT', price: '100', bid: '99.9', ask: '100.1', fetched_at: at } },
    accounts: {
      'usdm:BTC_USDT': {
        schema: 'tyche_account_epoch/v1',
        account_epoch_id: 'tae_fixture',
        product: 'usdm',
        environment: 'testnet',
        funding_source: 'usdm_testnet_available',
        wallet: 'USDT_FUTURES_TESTNET',
        asset: 'USDT',
        symbol: 'BTC_USDT',
        generated_at: at,
        available_quote: '1000',
        effective_risk_capital: '1000',
        managed_quantity: '0',
        managed_notional: '0',
        daily_new_notional_used: '0',
        daily_order_count: 0
      }
    },
    reconciliation: { status: 'ok', generated_at: at, receipt_id: 'tr_fixture', issues: [] },
    blockers: []
  }
}

export function readyPlan(options = {}) {
  const config = options.config || manualConfig()
  const source = options.source || dailySource()
  const context = options.context || planContext()
  const anchor = options.weeklyAnchor || weeklyAnchor()
  const market = options.marketSnapshot || marketSnapshot()
  const plan = createPlan(source, { product: 'usdm', environment: 'testnet', config, context, ledger: options.ledger || { schema: 'tyche_gate_ledger/v1', plans: [], events: [], fills: [], reconciliations: [] }, date: DATE, isoWeek: WEEK, weeklyAnchor: anchor, marketSnapshot: market, now: NOW })
  if (plan.status !== 'READY') throw new Error(`Fixture plan unexpectedly ${plan.status}: ${JSON.stringify(plan.blockers)} ${JSON.stringify(plan.skipped)}`)
  return { plan, config, source, context }
}

export function jsonResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => data === null ? '' : JSON.stringify(data)
  }
}
