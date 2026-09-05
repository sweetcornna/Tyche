import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BINANCE_FIXED_HOSTS,
  binanceCanonicalQuery,
  binanceCredentialNames,
  binanceOperationDefinitions,
  createBinanceClient,
  hmacSha256
} from '../scripts/binance-rest.mjs'
import { jsonResponse, NOW } from './helpers.mjs'

const EXCHANGE_INFO = {
  symbols: [
    { symbol: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] },
    { symbol: 'ETHUSDT', contractType: 'PERPETUAL', status: 'TRADING', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] }
  ]
}

async function withCredentials(callback) {
  const names = binanceCredentialNames('testnet')
  const previous = { key: process.env[names.apiKey], secret: process.env[names.secretKey] }
  process.env[names.apiKey] = 'unit-test-key'
  process.env[names.secretKey] = 'unit-test-secret'
  try { return await callback(names) } finally {
    if (previous.key === undefined) delete process.env[names.apiKey]
    else process.env[names.apiKey] = previous.key
    if (previous.secret === undefined) delete process.env[names.secretKey]
    else process.env[names.secretKey] = previous.secret
  }
}

test('Binance routing retains production public reads while every mutation is testnet-only', async () => {
  assert.deepEqual(BINANCE_FIXED_HOSTS, { usdm_public: 'https://fapi.binance.com', usdm_testnet: 'https://testnet.binancefuture.com' })
  const mutations = Object.values(binanceOperationDefinitions).filter((row) => row.mutation)
  assert.ok(mutations.length >= 4)
  assert.ok(mutations.every((row) => row.environments.join(',') === 'testnet'))
  assert.ok(Object.values(binanceOperationDefinitions).every((row) => !/transfer|withdraw|deposit|cancelAll/i.test(row.path)))
  assert.deepEqual(binanceCredentialNames('testnet'), { apiKey: 'BINANCE_USDM_TESTNET_API_KEY', secretKey: 'BINANCE_USDM_TESTNET_SECRET_KEY' })
  assert.equal(binanceCredentialNames('public'), null)

  let calls = 0
  const client = createBinanceClient({ environment: 'public', fetchImpl: async () => { calls += 1; return jsonResponse(EXCHANGE_INFO) } })
  await assert.rejects(client.usdmPlaceOrder({ contract: 'BTC_USDT', size: 1, price: '100', tif: 'gtc', text: `t-TYE${'a'.repeat(22)}` }), { code: 'BINANCE_MUTATION_FORBIDDEN' })
  assert.equal(calls, 0)
  assert.throws(() => createBinanceClient({ environment: 'production' }), { code: 'BINANCE_ENVIRONMENT_UNSUPPORTED' })
  assert.throws(() => createBinanceClient({ environment: 'testnet', apiKey: 'forbidden' }), { code: 'BINANCE_CLIENT_OVERRIDE_FORBIDDEN' })
})

test('Binance signed testnet order uses deterministic HMAC-SHA256 and exact step units', async () => {
  await withCredentials(async (names) => {
    const calls = []
    const clientId = `t-TYE${'b'.repeat(22)}`
    const client = createBinanceClient({
      environment: 'testnet',
      now: () => NOW,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        if (url.endsWith('/fapi/v1/exchangeInfo')) return jsonResponse(EXCHANGE_INFO)
        if (url.endsWith('/fapi/v1/order')) return jsonResponse({ symbol: 'BTCUSDT', side: 'BUY', status: 'FILLED', orderId: 17, clientOrderId: clientId, origQty: '0.002', executedQty: '0.002', price: '100', reduceOnly: false })
        throw new Error(`unexpected ${url}`)
      }
    })
    const result = await client.usdmPlaceOrder({ contract: 'BTC_USDT', size: 2, price: '100', tif: 'gtc', text: clientId })
    assert.equal(result.data.size, 2)
    assert.equal(result.data.left, '0')
    assert.equal(result.data.status, 'finished')
    const request = calls[1]
    assert.equal(request.url, `${BINANCE_FIXED_HOSTS.usdm_testnet}/fapi/v1/order`)
    assert.equal(request.init.headers['X-MBX-APIKEY'], process.env[names.apiKey])
    const parameters = Object.fromEntries(new URLSearchParams(request.init.body))
    const signature = parameters.signature
    delete parameters.signature
    assert.equal(parameters.quantity, '0.002')
    assert.equal(parameters.newClientOrderId, clientId)
    assert.equal(signature, hmacSha256(process.env[names.secretKey], binanceCanonicalQuery(parameters)))
  })
})

test('Binance protection maps exact reduce-only units to the current algo-order endpoint', async () => {
  await withCredentials(async () => {
    const calls = []
    const clientId = `t-TYP${'c'.repeat(22)}`
    const client = createBinanceClient({
      environment: 'testnet',
      now: () => NOW,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        if (url.endsWith('/fapi/v1/exchangeInfo')) return jsonResponse(EXCHANGE_INFO)
        if (url.endsWith('/fapi/v1/algoOrder')) return jsonResponse({ algoId: 23, clientAlgoId: clientId, algoType: 'CONDITIONAL', orderType: 'STOP_MARKET', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC', quantity: '0.003', algoStatus: 'NEW', triggerPrice: '90', workingType: 'MARK_PRICE', reduceOnly: true })
        throw new Error(`unexpected ${url}`)
      }
    })
    const result = await client.usdmPlacePriceOrder({
      initial: { contract: 'BTC_USDT', size: -3, price: '0', tif: 'ioc', text: clientId, reduce_only: true },
      trigger: { strategy_type: 0, price_type: 1, price: '90', rule: 2, expiration: 86400 }
    })
    assert.equal(result.data.status, 'open')
    const request = calls[1]
    const parameters = Object.fromEntries(new URLSearchParams(request.init.body))
    assert.equal(parameters.algoType, 'CONDITIONAL')
    assert.equal(parameters.type, 'STOP_MARKET')
    assert.equal(parameters.workingType, 'MARK_PRICE')
    assert.equal(parameters.reduceOnly, 'true')
    assert.equal(parameters.clientAlgoId, clientId)
  })
})

test('Binance account and position responses normalize into deterministic Gate-engine proofs', async () => {
  await withCredentials(async () => {
    const client = createBinanceClient({
      environment: 'testnet',
      now: () => NOW,
      fetchImpl: async (url) => {
        if (url.endsWith('/fapi/v1/exchangeInfo')) return jsonResponse(EXCHANGE_INFO)
        if (url.startsWith(`${BINANCE_FIXED_HOSTS.usdm_testnet}/fapi/v3/account?`)) return jsonResponse({ assets: [{ asset: 'USDT', availableBalance: '123.45' }] })
        if (url.startsWith(`${BINANCE_FIXED_HOSTS.usdm_testnet}/fapi/v1/positionSide/dual?`)) return jsonResponse({ dualSidePosition: false })
        if (url.includes('/fapi/v2/positionRisk?')) return jsonResponse([{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '-0.004', marginType: 'isolated', leverage: '2' }])
        throw new Error(`unexpected ${url}`)
      }
    })
    const [account, position] = await Promise.all([client.usdmAccount(), client.usdmPosition({ contract: 'BTC_USDT' })])
    assert.deepEqual(account.data, { currency: 'USDT', available: '123.45', in_dual_mode: false, _tyche_wallet: 'BINANCE_USDT_FUTURES_TESTNET', _tyche_funding_source: 'binance_usdm_testnet_available' })
    assert.deepEqual(position.data, { contract: 'BTC_USDT', symbol: 'BTC_USDT', mode: 'single', pos_margin_mode: 'isolated', lever: '2', size: '-4' })
  })
})

test('exact Binance client identity requires definitive not-found proof from both supported symbols', async () => {
  await withCredentials(async () => {
    const identity = `t-TYE${'d'.repeat(22)}`
    let calls = 0
    const client = createBinanceClient({
      environment: 'testnet',
      now: () => NOW,
      fetchImpl: async (url) => {
        if (url.endsWith('/fapi/v1/exchangeInfo')) return jsonResponse(EXCHANGE_INFO)
        if (url.includes('/fapi/v1/order?')) {
          calls += 1
          return jsonResponse({ code: -2013, msg: 'Order does not exist.' }, 400)
        }
        throw new Error(`unexpected ${url}`)
      }
    })
    await assert.rejects(client.findUsdmOrderByText(identity), (error) => error.definitiveNotFound === true && error.lookupIdentity === identity && error.operation === 'usdmOrder')
    assert.equal(calls, 2)
  })
})

test('Binance rule aggregation preserves lot units, minimum notional, fees, and risk bracket', async () => {
  await withCredentials(async () => {
    const client = createBinanceClient({
      environment: 'testnet',
      now: () => NOW,
      fetchImpl: async (url) => {
        if (url.endsWith('/fapi/v1/exchangeInfo')) return jsonResponse(EXCHANGE_INFO)
        if (url.includes('/fapi/v1/commissionRate?')) return jsonResponse({ symbol: 'BTCUSDT', makerCommissionRate: '0.0002', takerCommissionRate: '0.0005' })
        if (url.includes('/fapi/v1/leverageBracket?')) return jsonResponse([{ symbol: 'BTCUSDT', brackets: [{ bracket: 1, initialLeverage: 125, maintMarginRatio: '0.004' }] }])
        throw new Error(`unexpected ${url}`)
      }
    })
    const result = await client.usdmContract({ contract: 'BTC_USDT' })
    assert.equal(result.data.quanto_multiplier, '0.001')
    assert.equal(result.data.order_size_min, '1')
    assert.equal(result.data.min_notional, '5')
    assert.equal(result.data.taker_fee_rate, '0.0005')
    assert.equal(result.data.maintenance_rate, '0.004')
    assert.equal(result.data.status, 'trading')
  })
})

test('Binance mutation transport never retries an ambiguous server response', async () => {
  await withCredentials(async () => {
    let mutationCalls = 0
    const client = createBinanceClient({
      environment: 'testnet',
      now: () => NOW,
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith('/fapi/v1/exchangeInfo')) return jsonResponse(EXCHANGE_INFO)
        if (url.endsWith('/fapi/v1/order')) {
          mutationCalls += 1
          return jsonResponse({ code: -1000, msg: 'Unknown error.' }, 503)
        }
        throw new Error(`unexpected ${url}`)
      }
    })
    await assert.rejects(client.usdmPlaceOrder({ contract: 'BTC_USDT', size: 1, price: '100', tif: 'gtc', text: `t-TYE${'e'.repeat(22)}` }), (error) => error.ambiguous === true && error.status === 503)
    assert.equal(mutationCalls, 1)
  })
})

test('Binance normalized algo orders preserve trigger direction and signed trade units', async () => {
  await withCredentials(async () => {
    const client = createBinanceClient({
      environment: 'testnet',
      now: () => NOW,
      fetchImpl: async (url) => {
        if (url.endsWith('/fapi/v1/exchangeInfo')) return jsonResponse(EXCHANGE_INFO)
        if (url.includes('/fapi/v1/openAlgoOrders?')) {
          return url.includes('symbol=BTCUSDT')
            ? jsonResponse([{ algoId: 41, clientAlgoId: `t-TYP${'f'.repeat(22)}`, algoType: 'CONDITIONAL', orderType: 'TAKE_PROFIT_MARKET', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', timeInForce: 'GTC', quantity: '0.002', algoStatus: 'TRIGGERING', triggerPrice: '120', workingType: 'CONTRACT_PRICE', reduceOnly: true }])
            : jsonResponse([])
        }
        if (url.includes('/fapi/v1/userTrades?')) return jsonResponse([{ id: 51, orderId: 17, side: 'SELL', qty: '0.002', price: '101' }])
        throw new Error(`unexpected ${url}`)
      }
    })
    const protections = await client.usdmPriceOrders({ status: 'open', contract: 'BTC_USDT' })
    assert.equal(protections.data[0].status, 'open')
    assert.equal(protections.data[0].initial.size, -2)
    assert.equal(protections.data[0].initial.tif, 'gtc')
    assert.equal(protections.data[0].trigger.rule, 1)
    assert.equal(protections.data[0].trigger.price_type, 0)
    const trades = await client.usdmTrades({ contract: 'BTC_USDT', order: 17 })
    assert.deepEqual(trades.data[0], { id: '51', trade_id: '51', order_id: '17', contract: 'BTC_USDT', size: '-2', price: '101', text: '' })
  })
})

test('Binance position normalization fails closed without one-way or isolated proof', async () => {
  await withCredentials(async () => {
    const calls = []
    const client = createBinanceClient({
      environment: 'testnet',
      now: () => NOW,
      fetchImpl: async (url) => {
        calls.push(url)
        if (url.includes('/fapi/v1/positionSide/dual?')) return jsonResponse({ dualSidePosition: true })
        throw new Error(`unexpected ${url}`)
      }
    })
    await assert.rejects(client.usdmPositions(), { code: 'BINANCE_ONE_WAY_UNPROVEN' })
    assert.equal(calls.some((url) => url.includes('/fapi/v2/positionRisk')), false)
  })
})

test('Binance operation definitions cannot be mutated into caller-controlled routes', () => {
  assert.throws(() => binanceOperationDefinitions.placeOrder.params.push('url'), TypeError)
  assert.throws(() => { binanceOperationDefinitions.placeOrder.path = '/evil' }, TypeError)
})
