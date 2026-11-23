import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'usage-balance-test-'))
process.env.DSH_HOME = home
process.env.DSH_USAGE_BALANCE_CATALOG = join(home, 'no-catalog')

const mod = await import('../lib/index.js')

function makeHost(options = {}) {
  const captured = {}
  let dispose = null
  const ctx = {
    inject(_deps, callback) {
      callback(this)
    },
    on(name, fn) {
      if (name === 'session/event') captured.event = fn
    },
    effect(fn) {
      dispose = fn()
    },
    get(name) {
      if (name === 'sessions') return options.sessions ?? { list: () => [], get: () => undefined }
      if (name === 'sessionProjections') return options.projections ?? { snapshot: () => ({ values: {} }) }
      if (name === 'credentials') return options.credentials
      if (name === 'deepseekAccount') return options.account
      return undefined
    },
    dshGo: {
      strip(_id, fn) {
        captured.strip = fn
      },
      turnNote(_id, fn) {
        captured.note = fn
      },
      panel(_id, def) {
        captured.panel = def
      },
    },
  }
  mod.apply(ctx)
  return {
    captured,
    dispose() {
      if (dispose !== null) dispose()
    },
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readPanel(captured, sessionId, locale = 'zh-CN') {
  let data = null
  const cancel = captured.panel.data({ sessionId }, (value) => {
    data = value
  }, { locale })
  cancel()
  return data
}

function readStrip(captured, sessionId) {
  let value = null
  const cancel = captured.strip({ sessionId }, (next) => {
    value = next
  }, { locale: 'zh-CN' })
  cancel()
  return value
}

test('状态条按 本次/对话/今日 输出花费', () => {
  mod.__reset()
  const host = makeHost()
  const strip = readStrip(host.captured, undefined)
  const panel = readPanel(host.captured, undefined)
  host.dispose()
  assert.match(strip.text, /^今日¥/)
  assert.ok([...strip.text].length <= 24, `状态条不应超过 24 字：${strip.text}`)
  assert.equal(panel.summaryRows.length, 3)
  assert.deepEqual(panel.summaryRows.map((row) => row[0]), ['本对话', '今日', '近 7 天'])
})

test('当前会话优先复用引擎 tokenUsage 投影', () => {
  mod.__reset()
  const session = { id: 's1' }
  const host = makeHost({
    sessions: { list: () => [session], get: (id) => (id === 's1' ? session : undefined) },
    projections: {
      snapshot: () => ({
        values: { tokenUsage: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0 } },
      }),
    },
  })
  const panel = readPanel(host.captured, 's1')
  host.dispose()
  assert.equal(panel.sessionTotal, '1.7k')
  assert.equal(panel.sessionInput, '1k')
  assert.equal(panel.sessionCache, '500')
})

test('余额优先走 DSH 账号服务', async () => {
  mod.__reset()
  const host = makeHost({
    account: {
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: '10.00' }],
        bonusWallets: [],
      }),
    },
    credentials: { resolve: async () => ({ value: 'sk-should-not-be-used' }) },
  })
  readStrip(host.captured, undefined)
  await wait(50)
  const panel = readPanel(host.captured, undefined)
  host.dispose()
  assert.equal(panel.balance, '¥10.00')
  assert.equal(panel.balanceCaption, '充值 ¥10.00')
})

test('余额连续失败进入退避，不报错打扰', async () => {
  mod.__reset()
  const host = makeHost({
    account: { getBalance: async () => ({ status: 'failed' }) },
    credentials: { resolve: async () => ({ value: '' }) },
  })
  readStrip(host.captured, undefined)
  await wait(60)
  const state = mod.__state()
  const panel = readPanel(host.captured, undefined)
  host.dispose()
  assert.ok(state.balance.failures >= 1, '应记录失败次数')
  assert.ok(state.balance.nextAt > Date.now(), '应设置下次重试时间')
  assert.match(panel.balanceCaption, /暂不可用/)
})

test('远程价目拉取失败进入退避，不重复打请求', async () => {
  mod.__reset()
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('offline')
  }
  try {
    const host = makeHost()
    host.captured.event({ id: 'u1' }, { type: 'request/context', data: { model: 'unheard-model-x', provider: 'relay' } })
    host.captured.event({ id: 'u1' }, {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1100 } },
    })
    await wait(100)
    const first = mod.__state().remote
    assert.ok(first.failures >= 1, '失败应记录')
    assert.ok(first.nextAt > Date.now(), '失败应进入退避')
    assert.equal(calls, 4, `应为 4 个价目源各请求一次，实际 ${calls}`)
    // 退避期内再次查询不应再发请求
    host.captured.panel.data({ sessionId: 'u1' }, () => {}, { locale: 'zh-CN' })
    await wait(80)
    assert.equal(calls, 4, `退避期内不应重复请求，实际 ${calls}`)
    host.dispose()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('手动刷新会中止在途请求，旧结果不会覆盖新值', async () => {
  mod.__reset()
  let call = 0
  const host = makeHost({
    account: {
      getBalance: async () => {
        call += 1
        if (call === 1) {
          await wait(500)
          return { status: 'ready', value: [{ currency: 'CNY', balance: '99.00' }], bonusWallets: [] }
        }
        return { status: 'ready', value: [{ currency: 'CNY', balance: '20.00' }], bonusWallets: [] }
      },
    },
    credentials: { resolve: async () => ({ value: '' }) },
  })
  // 先启动一次自动查询（第一次很慢）
  host.captured.strip({ sessionId: undefined }, () => {}, { locale: 'zh-CN' })
  await wait(30)
  // 手动刷新：应中止旧请求并强制新读
  await host.captured.panel.actions.refresh({}, { locale: 'zh-CN' })
  assert.equal(readPanel(host.captured, undefined).balance, '¥20.00')
  await wait(600)
  assert.equal(readPanel(host.captured, undefined).balance, '¥20.00', '旧请求的结果不能覆盖')
  host.dispose()
})

test('余额字段缺失时显示 —，不伪装成 0 元', async () => {
  mod.__reset()
  const host = makeHost({
    account: { getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY' }], bonusWallets: [] }) },
    credentials: { resolve: async () => ({ value: '' }) },
  })
  host.captured.strip({ sessionId: undefined }, () => {}, { locale: 'zh-CN' })
  await wait(60)
  const panel = readPanel(host.captured, undefined)
  host.dispose()
  assert.equal(panel.balance, '—')
  assert.notEqual(panel.balance, '¥0.00')
})

test('冷会话折叠成汇总，重新打开后继续累计', () => {
  mod.__reset()
  const host = makeHost()
  const costOf = (panel, label) => panel.summaryRows.find((row) => row[0] === label)?.[1]
  const oldTime = Date.now() - 10 * 86_400_000
  host.captured.event({ id: 'old1' }, { type: 'request/context', data: { model: 'deepseek-flash', provider: 'deepseek-account' } })
  host.captured.event({ id: 'old1' }, {
    type: 'assistant/message',
    seq: 1,
    time: oldTime,
    data: { turn: 1, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 } },
  })
  readPanel(host.captured, 'old1') // 触发一次扫描，执行折叠
  assert.ok(mod.__state().ledger.cold >= 1, '超过 8 天的会话应被折叠')
  const before = readPanel(host.captured, 'old1')
  assert.equal(before.rows.length, 0, '折叠后不再有逐轮明细')
  assert.notEqual(costOf(before, '本对话'), '¥0.00', '汇总花费应保留')

  host.captured.event({ id: 'old1' }, {
    type: 'assistant/message',
    seq: 2,
    time: Date.now(),
    data: { turn: 2, usage: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 } },
  })
  const after = readPanel(host.captured, 'old1')
  assert.equal(after.rows.length, 1, '重新打开后只显示新轮次')
  assert.notEqual(costOf(after, '本对话'), costOf(before, '本对话'), '新轮次应继续累计')
  host.dispose()
})

test('英文环境下面板与状态条用英文', () => {
  mod.__reset()
  const host = makeHost()
  const panel = readPanel(host.captured, undefined, 'en-US')
  const stripCancel = host.captured.strip({ sessionId: undefined }, () => {}, { locale: 'en-US' })
  const view = host.captured.panel.view({}, { locale: 'en-US' })
  host.dispose()
  stripCancel()
  assert.equal(panel.summaryRows[0][0], 'This chat')
  assert.equal(panel.summaryRows[1][0], 'Today')
  assert.equal(view.children[1].columns[0], 'Item')
  assert.equal(view.children[2].label, 'Details')
})

test('逐轮表记录每轮使用的完整模型名', () => {
  mod.__reset()
  const host = makeHost()
  host.captured.event({ id: 'm1' }, { type: 'request/context', data: { model: 'deepseek-flash', provider: 'deepseek-account' } })
  host.captured.event({ id: 'm1' }, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1100 } },
  })
  const panel = readPanel(host.captured, 'm1')
  host.dispose()
  assert.equal(panel.rows[0][1], 'deepseek-flash')
  assert.equal(panel.rows[0][0], '1')
})

test('手动「价目」按钮会强制重新拉取并更新', async () => {
  mod.__reset()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      'gpt-test': { input_cost_per_token: 2.5e-06, output_cost_per_token: 1.5e-05, cache_read_input_token_cost: 2.5e-07 },
    }),
  })
  try {
    const host = makeHost()
    const result = host.captured.panel.actions.prices({}, { locale: 'zh-CN' })
    await wait(80)
    assert.match(result.toast, /价目/)
    assert.ok(mod.__state().remote.count >= 1, '应写入价目缓存')
    host.dispose()
  } finally {
    globalThis.fetch = realFetch
  }
})

test('目录价里的缓存写入也计入花费', () => {
  mod.__reset()
  const cacheDir = join(home, 'cache', 'dsh-go-usage-balance')
  mkdirSync(cacheDir, { recursive: true })
  const cacheFile = join(cacheDir, 'prices.json')
  writeFileSync(cacheFile, JSON.stringify({
    fetchedAt: Date.now(),
    prices: { 'x-write': { name: '', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 } },
  }))
  try {
    const host = makeHost()
    host.captured.event({ id: 'w1' }, { type: 'request/context', data: { model: 'x-write', provider: 'relay' } })
    host.captured.event({ id: 'w1' }, {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, totalTokens: 2_000_000 } },
    })
    const panel = readPanel(host.captured, 'w1')
    host.dispose()
    // 1M 输入 × $1 + 1M 缓存写入 × $3 = $4.00
    assert.equal(panel.summaryRows[0][1], '$4.00')
  } finally {
    rmSync(cacheFile, { force: true })
    mod.__reset()
  }
})

test('价目缓存过期后自动后台刷新', async () => {
  mod.__reset()
  const cacheDir = join(home, 'cache', 'dsh-go-usage-balance')
  mkdirSync(cacheDir, { recursive: true })
  const cacheFile = join(cacheDir, 'prices.json')
  writeFileSync(cacheFile, JSON.stringify({
    fetchedAt: Date.now() - 30 * 86_400_000,
    prices: { 'old-model': { name: '', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
  }))
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return {
      ok: true,
      json: async () => ({ 'fresh-model': { input_cost_per_token: 1e-06, output_cost_per_token: 2e-06 } }),
    }
  }
  try {
    const host = makeHost()
    // 触发一次未知模型计费，读取本地价目缓存
    host.captured.event({ id: 'stale' }, { type: 'request/context', data: { model: 'old-model', provider: 'relay' } })
    host.captured.event({ id: 'stale' }, {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: { turn: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1100 } },
    })
    mod.__tick()
    await wait(80)
    assert.ok(calls > 0, '过期缓存应触发刷新')
    assert.ok(mod.__state().remote.count >= 1)
    host.dispose()
  } finally {
    globalThis.fetch = realFetch
    rmSync(cacheFile, { force: true })
    mod.__reset()
  }
})

test('models.dev 同名模型优先官方报价', () => {
  const parsed = mod.__parse.modelsDev({
    cortecs: { models: { 'gpt-5.4': { cost: { input: 2.844, output: 17.058 } } } },
    openai: { models: { 'gpt-5.4': { name: 'GPT-5.4', cost: { input: 2.5, output: 15 } } } },
  })
  assert.equal(parsed['gpt-5.4'].input, 2.5, '裸模型名应取官方价')
  assert.equal(parsed['openai/gpt-5.4'].input, 2.5)
  assert.equal(parsed['cortecs/gpt-5.4'].input, 2.844, '转售商保留带前缀的键')
})

test('卸载后清掉定时器与订阅，不留僵尸轮询', () => {
  mod.__reset()
  const host = makeHost()
  // 保持订阅打开，模拟状态条正在显示
  host.captured.strip({ sessionId: undefined }, () => {}, { locale: 'zh-CN' })
  assert.equal(mod.__state().ticker, true, '有视图时应启动定时器')
  assert.equal(mod.__state().feeds, 1)
  host.dispose()
  const state = mod.__state()
  assert.equal(state.disposed, true)
  assert.equal(state.ticker, false, '卸载后定时器应为空')
  assert.equal(state.feeds, 0)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
