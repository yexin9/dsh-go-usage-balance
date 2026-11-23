// dsh-go-usage-balance —— 给 dsh-go 手机 App 的原生插件：
// 输入框上方的状态条（余额 + 本对话 token）、对话「插件」页签里的面板、每条回复的用量脚注。
// 余额优先读本机保存的 DeepSeek API Key 查询官方余额接口，查不到再用本机 DeepSeek 账号；
// 用量全部来自本机会话日志，不估算、不联网。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { panelView } from './view.js'
import { label, switchText } from './i18n.js'

export const name = 'dsh-go-usage-balance'

const LOG_FILE = 'session.v4.jsonl.zstd'
const SCAN_THROTTLE_MS = 60_000
const COLD_AFTER_MS = 8 * 86_400_000
const BALANCE_TTL_MS = 5 * 60_000
const TICK_MS = 15_000
const MAX_LOG_BYTES = 16 * 1024 * 1024
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** DeepSeek 官方价目（元 / 百万 tokens）：空闲价与高峰价。 */
const PRICES = {
  'deepseek-flash': { name: 'DeepSeek Flash', hitIdle: 0.02, hitPeak: 0.04, missIdle: 1, missPeak: 2, outIdle: 4, outPeak: 8 },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', hitIdle: 0.15, hitPeak: 0.30, missIdle: 4.5, missPeak: 9, outIdle: 13.5, outPeak: 27 },
}

/** pi-ai 的模型目录自带每个模型的美元价，GPT / Gemini 等直接读它，新模型不用手写。 */
let catalog = null

function findCatalogDir() {
  const override = process.env.DSH_USAGE_BALANCE_CATALOG
  if (typeof override === 'string' && override !== '' && existsSync(override)) return override
  const starts = [process.argv[1], process.cwd()]
  for (const start of starts) {
    if (typeof start !== 'string' || start === '') continue
    let dir = dirname(start)
    for (let depth = 0; depth < 10; depth += 1) {
      const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const known = ['/opt/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data']
  for (const candidate of known) if (existsSync(candidate)) return candidate
  return null
}

function collectCatalog(node, add) {
  if (Array.isArray(node)) {
    for (const item of node) collectCatalog(item, add)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (typeof node.id === 'string' && node.cost !== undefined && node.cost !== null && typeof node.cost === 'object') add(node)
  for (const value of Object.values(node)) collectCatalog(value, add)
}

function loadCatalog() {
  if (catalog !== null) return catalog
  catalog = new Map()
  const dir = findCatalogDir()
  if (dir === null) return catalog
  let files = []
  try {
    files = readdirSync(dir)
  } catch {
    return catalog
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    let data
    try {
      data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    } catch {
      continue
    }
    collectCatalog(data, (model) => {
      const price = {
        source: 'pi-ai',
        name: typeof model.name === 'string' && model.name !== '' ? model.name : '',
        input: amount(model.cost.input),
        cacheRead: amount(model.cost.cacheRead),
        cacheWrite: amount(model.cost.cacheWrite),
        output: amount(model.cost.output),
      }
      if (typeof model.provider === 'string' && model.provider !== '') catalog.set(`${model.provider}|${model.id}`, price)
      if (!catalog.has(model.id)) catalog.set(model.id, price)
    })
  }
  return catalog
}

function catalogPrice(model, provider) {
  const map = loadCatalog()
  if (map.size === 0 || typeof model !== 'string' || model === '') return null
  if (typeof provider === 'string' && provider !== '') {
    const hit = map.get(`${provider}|${model}`)
    if (hit !== undefined) return hit
  }
  return map.get(model) ?? null
}

// ── 远程价目（LiteLLM 公开表，覆盖 7000+ 模型；查不到 pi-ai 目录时兜底） ──────────
const REMOTE_TTL_MS = 24 * 3_600_000
/** 价目源按优先级排列：先 models.dev（官方价，更新快），再 LiteLLM，最后 OpenRouter。 */
const REMOTE_SOURCES = [
  { url: 'https://models.dev/api.json', parse: parseModelsDev },
  { url: 'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json', parse: parseLiteLLM },
  { url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json', parse: parseLiteLLM },
  { url: 'https://openrouter.ai/api/v1/models', parse: parseOpenRouter },
]

/** models.dev：{ provider: { models: { id: { name, cost: { input, output, cache_read, cache_write } } } } } */
const OFFICIAL_PROVIDERS = new Set([
  'openai', 'anthropic', 'google', 'deepseek', 'xai', 'mistral', 'meta', 'cohere',
  'alibaba', 'zhipu', 'moonshot', 'minimax', 'nvidia', 'groq', 'cerebras', 'perplexity',
])

function parseModelsDev(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const official = {}
  const resellers = {}
  const full = {}
  for (const [providerId, provider] of Object.entries(raw)) {
    const models = provider?.models
    if (models === null || typeof models !== 'object') continue
    for (const [id, model] of Object.entries(models)) {
      const cost = model?.cost
      if (cost === null || typeof cost !== 'object') continue
      const entry = {
        name: typeof model.name === 'string' ? model.name : '',
        input: num(cost.input),
        output: num(cost.output),
        cacheRead: num(cost.cache_read),
        cacheWrite: num(cost.cache_write),
        source: 'models.dev',
      }
      if (entry.input <= 0 && entry.output <= 0) continue
      const key = id.toLowerCase()
      full[`${providerId.toLowerCase()}/${key}`] = full[`${providerId.toLowerCase()}/${key}`] ?? entry
      const bare = key.split('/').pop()
      const target = OFFICIAL_PROVIDERS.has(providerId.toLowerCase()) ? official : resellers
      if (!(bare in target)) target[bare] = entry
    }
  }
  // 官方提供方优先，其次才是转售商，最后是带提供方前缀的完整键
  for (const [key, entry] of Object.entries(resellers)) if (!(key in out)) out[key] = entry
  for (const [key, entry] of Object.entries(official)) out[key] = entry
  for (const [key, entry] of Object.entries(full)) if (!(key in out)) out[key] = entry
  return out
}

/** LiteLLM：{ id: { input_cost_per_token, output_cost_per_token, ... } } */
function parseLiteLLM(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const [id, info] of Object.entries(raw)) {
    if (id.startsWith('sample_spec') || info === null || typeof info !== 'object') continue
    const entry = {
      name: '',
      input: amount(info.input_cost_per_token) * 1e6,
      output: amount(info.output_cost_per_token) * 1e6,
      cacheRead: amount(info.cache_read_input_token_cost) * 1e6,
      cacheWrite: amount(info.cache_creation_input_token_cost) * 1e6,
      source: 'litellm',
    }
    if (entry.input <= 0 && entry.output <= 0) continue
    const key = id.toLowerCase()
    if (!(key in out)) out[key] = entry
  }
  return out
}

/** OpenRouter：{ data: [{ id, name, pricing: { prompt, completion, input_cache_read, input_cache_write } }] } */
function parseOpenRouter(raw) {
  const out = {}
  const list = Array.isArray(raw?.data) ? raw.data : []
  for (const model of list) {
    const pricing = model?.pricing
    if (pricing === null || typeof pricing !== 'object') continue
    const entry = {
      name: typeof model.name === 'string' ? model.name : '',
      input: amount(pricing.prompt) * 1e6,
      output: amount(pricing.completion) * 1e6,
      cacheRead: amount(pricing.input_cache_read) * 1e6,
      cacheWrite: amount(pricing.input_cache_write) * 1e6,
      source: 'openrouter',
    }
    if (entry.input <= 0 && entry.output <= 0) continue
    const key = String(model.id ?? '').toLowerCase()
    if (key !== '' && !(key in out)) out[key] = entry
  }
  return out
}
let remote = { prices: null, at: 0, loading: null, failures: 0, nextAt: 0 }

function remoteCachePath() {
  return join(dshHome(), 'cache', 'dsh-go-usage-balance', 'prices.json')
}

function readRemoteCache() {
  if (remote.prices !== null) return remote.prices
  try {
    const cached = JSON.parse(readFileSync(remoteCachePath(), 'utf8'))
    if (cached !== null && typeof cached === 'object' && cached.prices !== null && typeof cached.prices === 'object') {
      remote.prices = cached.prices
      remote.at = num(cached.fetchedAt)
      return remote.prices
    }
  } catch {
    // 第一次运行没有缓存
  }
  remote.prices = null
  return null
}

function remoteVariants(model, provider) {
  const list = [model]
  const lower = String(model).toLowerCase()
  if (lower !== model) list.push(lower)
  if (typeof provider === 'string' && provider !== '') {
    list.push(`${provider}/${model}`)
    if (provider === 'google') list.push(`gemini/${model}`)
    if (provider === 'openai') list.push(`openai/${model}`)
  }
  const stripped = lower.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '')
  if (stripped !== lower) list.push(stripped)
  return list
}

function remotePrice(model, provider) {
  const prices = readRemoteCache()
  if (prices === null) {
    kickRemoteFetch()
    return null
  }
  for (const key of remoteVariants(model, provider)) {
    const hit = prices[key] ?? prices[key.toLowerCase()]
    if (hit !== undefined) return { ...hit, source: hit.source ?? 'litellm' }
  }
  return null
}

/** 后台拉价目表，成功后写缓存并补算之前查不到价的轮次。 */
/** 本地缓存超过 24 小时就后台刷新；从没拉过价目的用户不主动下载。 */
function ensureRemoteFresh() {
  if (remote.prices === null || remote.loading !== null) return
  if (Date.now() - remote.at < REMOTE_TTL_MS) return
  kickRemoteFetch()
}

function refreshPrices() {
  remote.nextAt = 0
  remote.at = 0
  kickRemoteFetch()
  poke()
}

function kickRemoteFetch() {
  if (disposed || remote.loading !== null) return
  const now = Date.now()
  if (now < remote.nextAt) return
  if (remote.prices !== null && now - remote.at < REMOTE_TTL_MS) return
  remote.loading = (async () => {
    const merged = {}
    let any = false
    for (const source of REMOTE_SOURCES) {
      if (disposed) return
      const controller = new AbortController()
      const untrack = trackAbort(controller)
      try {
        const response = await fetch(source.url, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
        })
        if (!response.ok) continue
        const parsed = source.parse(await response.json())
        const keys = Object.keys(parsed)
        if (keys.length === 0) continue
        any = true
        for (const key of keys) if (!(key in merged)) merged[key] = parsed[key]
      } catch {
        // 换下一个源
      } finally {
        untrack()
      }
    }
    if (disposed) return
    if (!any) {
      remote.failures += 1
      remote.nextAt = Date.now() + Math.min(REMOTE_BACKOFF_MAX_MS, 30_000 * 2 ** Math.min(remote.failures - 1, 10))
      poke()
      return
    }
    remote.prices = merged
    remote.at = Date.now()
    remote.failures = 0
    remote.nextAt = 0
    try {
      mkdirSync(dirname(remoteCachePath()), { recursive: true })
      writeFileSync(remoteCachePath(), JSON.stringify({ fetchedAt: remote.at, prices: merged }), { mode: 0o600 })
    } catch {
      // 缓存写不了也能用内存里的
    }
    recomputeUnpriced()
  })().finally(() => { remote.loading = null })
}

/** 价目补到之前没算钱的轮次（模型后来才被收录时）。 */
function recomputeUnpriced() {
  let changed = false
  for (const record of ledger.values()) {
    if (record.turns === null) continue
    for (const agg of record.turns.values()) {
      if (agg.costCNY > 0 || agg.costUSD > 0) continue
      if (agg.input + agg.output + agg.cache <= 0) continue
      if (typeof agg.model !== 'string' || agg.model === '') continue
      const cost = usageCost(
        { inputTokens: agg.input, outputTokens: agg.output, cacheReadTokens: agg.cache },
        agg.model,
        agg.time,
        agg.provider,
      )
      if (cost.CNY > 0 || cost.USD > 0) {
        agg.costCNY = cost.CNY
        agg.costUSD = cost.USD
        changed = true
      }
    }
  }
  if (changed) poke()
}

/** 北京时间工作日 9:00-12:00、14:00-18:00 是高峰时段，其余为空闲时段。 */
function isPeak(ms) {
  const date = new Date(num(ms) + 8 * 3_600_000)
  const hour = date.getUTCHours()
  const day = date.getUTCDay()
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}

/** 一次调用的费用，按模型所属价目返回人民币或美元。未收录的模型不计花费。 */
function usageCost(usage, model, time, provider) {
  const name = model || 'deepseek-flash'
  const deep = PRICES[name]
  if (deep !== undefined) {
    const peak = isPeak(time)
    const hit = peak ? deep.hitPeak : deep.hitIdle
    const miss = peak ? deep.missPeak : deep.missIdle
    const out = peak ? deep.outPeak : deep.outIdle
    return {
      CNY: (num(usage.inputTokens) * miss + num(usage.cacheReadTokens) * hit + num(usage.outputTokens) * out) / 1e6,
      USD: 0,
    }
  }
  const cat = catalogPrice(name, provider) || remotePrice(name, provider)
  if (cat === null) return { CNY: 0, USD: 0 }
  return {
    CNY: 0,
    USD: (num(usage.inputTokens) * cat.input + num(usage.cacheReadTokens) * cat.cacheRead + num(usage.cacheWriteTokens) * num(cat.cacheWrite) + num(usage.outputTokens) * cat.output) / 1e6,
  }
}

/** 数字按价目显示：去掉多余的小数位（0.02、1、4.5、0.0825）。 */
function priceNumber(n) {
  return String(Number(Number(n).toFixed(4)))
}

/** 下一个切换时刻：9 点、12 点、14 点、18 点，工作日才有高峰。 */
function nextBoundary(nowMs) {
  const base = new Date(nowMs + 8 * 3_600_000)
  for (let add = 0; add < 8; add += 1) {
    const day = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + add))
    const weekday = day.getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (const hour of [9, 12, 14, 18]) {
      const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour) - 8 * 3_600_000
      if (at > nowMs + 30_000) return { at, peak: hour === 9 || hour === 14 }
    }
  }
  return null
}


/** 当前模型的价格状态：DeepSeek 分峰谷，其他模型用目录里的美元价。 */
function priceStatus(model, provider, locale) {
  const name = model || 'deepseek-flash'
  const deep = PRICES[name]
  if (deep !== undefined) {
    const now = Date.now()
    const peak = isPeak(now)
    const next = nextBoundary(now)
    const when = next === null ? '' : switchText(locale, next.at, next.peak, now)
    const cell = (miss, hit, out) => [`¥${priceNumber(miss)}`, `¥${priceNumber(hit)}`, `¥${priceNumber(out)}`]
    return {
      accent: peak ? 'orange' : 'green',
      title: `${name} ${label(locale, 'priceTitleCny')}`,
      note: `${deep.name} · ${peak ? label(locale, 'peakPrice') : label(locale, 'idlePrice')}${when === '' ? '' : ` · ${when}`}`,
      rows: [
        [label(locale, 'idlePrice'), ...cell(deep.missIdle, deep.hitIdle, deep.outIdle)],
        [label(locale, 'peakPrice'), ...cell(deep.missPeak, deep.hitPeak, deep.outPeak)],
      ],
    }
  }
  const cat = catalogPrice(name, provider) || remotePrice(name, provider)
  if (cat === null) {
    const note = remote.loading !== null
      ? `${name} · ${label(locale, 'priceQuerying')}`
      : `${name} · ${label(locale, 'priceNotListed')}`
    return { accent: 'gray', title: `${name} ${label(locale, 'priceMissingTitle')}`, note, rows: [] }
  }
  const usd = (value) => `$${priceNumber(value)}`
  const sourceKeys = {
    'pi-ai': 'priceSourcePi',
    litellm: 'priceSourceLite',
    'models.dev': 'priceSourceModels',
    openrouter: 'priceSourceOpenRouter',
  }
  const source = label(locale, sourceKeys[cat.source] ?? 'priceSourcePi')
  const display = cat.name === undefined || cat.name === '' ? name : `${cat.name}（${name}）`
  return {
    accent: 'blue',
    title: `${name} ${label(locale, 'priceTitleUsd')}`,
    note: `${display} · ${source}`,
    rows: [[label(locale, 'standardPrice'), usd(cat.input), usd(cat.cacheRead), usd(cat.output)]],
  }
}

/** 余额接口给的是十进制字符串（"37.92"），用量接口给的是数字。 */
const amount = (v) => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/** sessionId -> { origin, turns: Map<turn, { time, input, output, cache, total, calls }>, seqs: Set } */
const ledger = new Map()
/** 日志文件 -> { mtimeMs, size }，没变过的文件不重复解压 */
const fileState = new Map()
/** 正在显示的状态条 / 面板数据源，新的用量到达时通知它们刷新 */
const scannedLive = new Set()
const coldSessions = new Set()
const skipScan = new Set()

let lastScan = 0
let scanNote = ''
let lastModel = ''
let lastProvider = ''
let lastModelTime = 0

// ── 轮询：一个定时器、按需启停、退出时清理 ─────────────────────────────────
const POKE_DEBOUNCE_MS = 200
const IDLE_TICK_MS = 60_000
const ACTIVE_WINDOW_MS = 120_000
const BALANCE_BACKOFF_MAX_MS = 10 * 60_000
const ACCOUNT_TIMEOUT_MS = 6_000
const REMOTE_BACKOFF_MAX_MS = 6 * 3_600_000

const feeds = new Set()
let ctxRef = null
let ticker = null
let pokeTimer = null
let disposed = false
let lastActivity = Date.now()
const aborters = new Set()

/** 有最近活动时 15 秒一轮，安静两分钟后降到 60 秒一轮。 */
function nextTickDelay() {
  return Date.now() - lastActivity < ACTIVE_WINDOW_MS ? TICK_MS : IDLE_TICK_MS
}

function scheduleTick() {
  if (disposed) return
  if (ticker !== null) clearTimeout(ticker)
  ticker = setTimeout(runTick, nextTickDelay())
  ticker.unref?.()
}

function runTick() {
  ticker = null
  if (disposed) return
  tick()
  scheduleTick()
}

function ensureTicker() {
  if (ticker !== null || disposed) return
  scheduleTick()
}

function stopTickerIfIdle() {
  if (feeds.size === 0 && ticker !== null) {
    clearTimeout(ticker)
    ticker = null
  }
}

function tick() {
  if (disposed) return
  scanLogs()
  ensureRemoteFresh()
  for (const update of [...feeds]) {
    try {
      update()
    } catch {
      // 单个视图出错不影响其他视图
    }
  }
}

function poke() {
  if (disposed) return
  lastActivity = Date.now()
  if (pokeTimer !== null) return
  pokeTimer = setTimeout(() => {
    pokeTimer = null
    for (const update of [...feeds]) {
      try {
        update()
      } catch {
        // ignore
      }
    }
  }, POKE_DEBOUNCE_MS)
  pokeTimer.unref?.()
}

function addFeed(update) {
  feeds.add(update)
  lastActivity = Date.now()
  ensureTicker()
}

function removeFeed(update) {
  feeds.delete(update)
  stopTickerIfIdle()
}

function trackAbort(controller) {
  aborters.add(controller)
  return () => aborters.delete(controller)
}

function disposeRuntime() {
  disposed = true
  if (ticker !== null) {
    clearTimeout(ticker)
    ticker = null
  }
  if (pokeTimer !== null) {
    clearTimeout(pokeTimer)
    pokeTimer = null
  }
  for (const controller of aborters) {
    try {
      controller.abort()
    } catch {
      // 已经中止
    }
  }
  aborters.clear()
  feeds.clear()
}

// ── 用量账本 ────────────────────────────────────────────────────────────────

function addUsage(sessionId, origin, seq, turn, time, usage, model, provider) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  let record = ledger.get(sessionId)
  if (record !== undefined && record.turns === null) {
    // 冷会话重新打开：用汇总做基线，之后只记新事件
    const summary = record.summary
    const expanded = { origin: record.origin, model: record.model, provider: record.provider, seqs: new Set(), turns: new Map(), summary: null }
    expanded.turns.set(-1, {
      time: summary.time,
      input: summary.input,
      output: summary.output,
      cache: summary.cache,
      total: summary.total,
      costCNY: summary.costCNY,
      costUSD: summary.costUSD,
      calls: summary.calls,
      model: record.model,
      provider: record.provider,
    })
    ledger.set(sessionId, expanded)
    coldSessions.delete(sessionId)
    skipScan.add(sessionId)
    record = expanded
  }
  if (record === undefined) {
    record = { origin: '', model: '', provider: '', seqs: new Set(), turns: new Map() }
    ledger.set(sessionId, record)
  }
  if (typeof origin === 'string' && origin !== '' && record.origin === '') record.origin = origin
  if (typeof model === 'string' && model !== '') record.model = model
  if (typeof provider === 'string' && provider !== '') record.provider = provider
  const key = typeof seq === 'number' ? seq : `t${String(time)}`
  if (record.seqs.has(key)) return false
  record.seqs.add(key)
  const turnNo = typeof turn === 'number' ? turn : 0
  let agg = record.turns.get(turnNo)
  if (agg === undefined) {
    agg = { time: 0, input: 0, output: 0, cache: 0, total: 0, costCNY: 0, costUSD: 0, calls: 0, model: '', provider: '' }
    record.turns.set(turnNo, agg)
  }
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const cache = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  agg.time = Math.max(agg.time, num(time))
  agg.input += input
  agg.output += output
  agg.cache += cache
  agg.total += num(usage.totalTokens) || input + output + cache + cacheWrite
  const usedModel = model || record.model
  const usedProvider = provider || record.provider
  if (typeof usedModel === 'string' && usedModel !== '') agg.model = usedModel
  if (typeof usedProvider === 'string' && usedProvider !== '') agg.provider = usedProvider
  const cost = usageCost(usage, usedModel, time, usedProvider)
  agg.costCNY += cost.CNY
  agg.costUSD += cost.USD
  agg.calls += 1
  return true
}

/** 把 8 天没用过、也不在运行中的会话折叠成一条汇总，减少长期内存。 */
function collapseCold(live) {
  const cutoff = Date.now() - COLD_AFTER_MS
  for (const [id, record] of ledger) {
    if (record.turns === null) {
      coldSessions.add(id)
      continue
    }
    if (live !== null && live.has(id)) continue
    let last = 0
    const totals = emptyTotals()
    for (const agg of record.turns.values()) {
      last = Math.max(last, agg.time)
      totals.input += agg.input
      totals.output += agg.output
      totals.cache += agg.cache
      totals.total += agg.total
      totals.costCNY += agg.costCNY
      totals.costUSD += agg.costUSD
      totals.calls += agg.calls
      totals.turns += 1
    }
    if (last === 0 || last >= cutoff) continue
    record.summary = {
      time: last,
      input: totals.input,
      output: totals.output,
      cache: totals.cache,
      total: totals.total,
      costCNY: totals.costCNY,
      costUSD: totals.costUSD,
      calls: totals.calls,
      turns: totals.turns,
    }
    record.turns = null
    record.seqs = null
    coldSessions.add(id)
  }
}

function liveSessionIds() {
  const sessions = ctxRef?.get?.('sessions')
  if (sessions === undefined || typeof sessions.list !== 'function') return null
  try {
    return new Set(sessions.list().map((session) => session.id))
  } catch {
    return null
  }
}

function scanLogs(force = false) {
  const now = Date.now()
  if (!force && now - lastScan < SCAN_THROTTLE_MS) return
  lastScan = now
  const live = liveSessionIds()
  const root = join(dshHome(), 'sessions')
  let groups
  try {
    groups = readdirSync(root, { withFileTypes: true })
  } catch {
    collapseCold(live)
    return
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = join(root, group.name)
    let sessions
    try {
      sessions = readdirSync(groupDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of sessions) {
      if (!entry.isDirectory()) continue
      // 活跃会话的后续事件走 session/event 和投影，不再反复解压同一个日志
      if (live !== null && live.has(entry.name) && scannedLive.has(entry.name)) continue
      // 冷会话只保留汇总；折叠后重新打开的会话只用实时事件，不再回读旧日志
      if (coldSessions.has(entry.name) || skipScan.has(entry.name)) continue
      const file = join(groupDir, entry.name, LOG_FILE)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size === 0) continue
      const seen = fileState.get(file)
      if (seen !== undefined && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) continue
      if (stat.size > MAX_LOG_BYTES) {
        scanNote = '有日志太大，已跳过'
        continue
      }
      try {
        parseLog(file, zstdDecompressSync(readFileSync(file)).toString('utf8'))
        fileState.set(file, { mtimeMs: stat.mtimeMs, size: stat.size })
        if (live !== null && live.has(entry.name)) scannedLive.add(entry.name)
      } catch {
        // 引擎还在写这个文件，下次再读
      }
    }
  }
  collapseCold(live)
}

function parseLog(file, text) {
  let id = ''
  let origin = ''
  let model = ''
  let provider = ''
  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'session') {
      if (typeof event.id === 'string') id = event.id
      if (typeof event.origin === 'string') origin = event.origin
      continue
    }
    if (event.type === 'request/context') {
      if (typeof event?.data?.model === 'string') {
        model = event.data.model
        if (typeof event?.data?.provider === 'string') provider = event.data.provider
        if (num(event.time) > lastModelTime) {
          lastModelTime = num(event.time)
          lastModel = model
          lastProvider = provider
        }
      }
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event?.data?.usage
    if (usage === undefined || usage === null || typeof usage !== 'object') continue
    addUsage(id || basename(dirname(file)), origin, event.seq, event?.data?.turn, event.time, usage, model, provider)
  }
}

function emptyTotals() {
  return { input: 0, output: 0, cache: 0, total: 0, costCNY: 0, costUSD: 0, calls: 0, turns: 0 }
}

function sessionTotals(sessionId) {
  const totals = emptyTotals()
  if (typeof sessionId !== 'string') return totals
  const record = ledger.get(sessionId)
  if (record === undefined) return totals
  if (record.turns === null) return { ...record.summary }
  for (const agg of record.turns.values()) {
    totals.input += agg.input
    totals.output += agg.output
    totals.cache += agg.cache
    totals.total += agg.total
    totals.costCNY += agg.costCNY
    totals.costUSD += agg.costUSD
    totals.calls += agg.calls
    totals.turns += 1
  }
  return totals
}

function rangeTotals(from, to) {
  const totals = emptyTotals()
  for (const record of ledger.values()) {
    if (record.turns === null) {
      const summary = record.summary
      if (summary.time < from || summary.time >= to) continue
      totals.input += summary.input
      totals.output += summary.output
      totals.cache += summary.cache
      totals.total += summary.total
      totals.costCNY += summary.costCNY
      totals.costUSD += summary.costUSD
      totals.calls += summary.calls
      totals.turns += summary.turns
      continue
    }
    for (const agg of record.turns.values()) {
      if (agg.time < from || agg.time >= to) continue
      totals.input += agg.input
      totals.output += agg.output
      totals.cache += agg.cache
      totals.total += agg.total
      totals.costCNY += agg.costCNY
      totals.costUSD += agg.costUSD
      totals.calls += agg.calls
      totals.turns += 1
    }
  }
  return totals
}

function lastTurn(sessionId) {
  if (typeof sessionId !== 'string') return null
  const record = ledger.get(sessionId)
  if (record === undefined || record.turns === null || record.turns.size === 0) return null
  let best = null
  for (const [turn, agg] of record.turns) {
    if (best === null || turn > best.turn) best = { ...agg, turn }
  }
  return best
}

function todayStart() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function compact(value) {
  const n = num(value)
  if (n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  const unit = n < 1e6 ? [1e3, 'k'] : n < 1e9 ? [1e6, 'M'] : [1e9, 'G']
  const scaled = n / unit[0]
  const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '')
  return text + unit[1]
}

function money(value) {
  const n = amount(value)
  return n.toFixed(2)
}

function moneyText(value, currency) {
  const n = amount(value)
  const symbol = currency === 'USD' ? '$' : '¥'
  if (!(n > 0)) return `${symbol}0.00`
  return n < 0.01 ? `${symbol}${n.toFixed(4)}` : `${symbol}${n.toFixed(2)}`
}

/** 人民币美元混用时都列出来，例如 ¥1.20+$0.35。 */
function costsText(cny, usd) {
  const parts = []
  if (amount(cny) > 0) parts.push(moneyText(cny, 'CNY'))
  if (amount(usd) > 0) parts.push(moneyText(usd, 'USD'))
  return parts.length === 0 ? '¥0.00' : parts.join('+')
}

/** 状态条放不下时的一档小数写法。 */
function costsShort(cny, usd) {
  const parts = []
  if (amount(cny) > 0) parts.push(`¥${amount(cny).toFixed(1)}`)
  if (amount(usd) > 0) parts.push(`$${amount(usd).toFixed(1)}`)
  return parts.length === 0 ? '¥0.0' : parts.join('+')
}

function percent(part, whole) {
  if (!(whole > 0)) return '—'
  return `${Math.round((part / whole) * 100)}%`
}

// ── 余额 ────────────────────────────────────────────────────────────────────

function accountClient(locale) {
  let version = '0.2.2'
  try {
    const runtime = JSON.parse(readFileSync('/etc/dsh-app/runtime.json', 'utf8'))
    if (typeof runtime?.dshVersion === 'string' && runtime.dshVersion !== '') version = runtime.dshVersion
  } catch {
    // 远程主机上没有这个文件，用默认版本号
  }
  return {
    version,
    locale: typeof locale === 'string' && locale !== '' ? locale : 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

function numericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return true
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return true
  return false
}

function normalizeWallets(list) {
  const byCurrency = new Map()
  for (const wallet of list) {
    if (!numericValue(wallet?.total) && !numericValue(wallet?.recharged) && !numericValue(wallet?.granted)) continue
    const currency = wallet?.currency === 'USD' ? 'USD' : 'CNY'
    const total = amount(wallet?.total)
    const recharged = amount(wallet?.recharged)
    const granted = amount(wallet?.granted)
    const one = byCurrency.get(currency) || { currency, total: 0, recharged: 0, granted: 0 }
    one.total += total
    one.recharged += recharged
    one.granted += granted
    byCurrency.set(currency, one)
  }
  return byCurrency.size > 0 ? [...byCurrency.values()] : null
}

async function apiKeyBalance(ctx, outerSignal) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') return null
  let hit
  try {
    hit = await credentials.resolve('DEEPSEEK_API_KEY')
  } catch {
    return null
  }
  const key = typeof hit?.value === 'string' ? hit.value : ''
  if (key === '') return null
  try {
    const response = await fetch(BALANCE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.any([outerSignal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok) return null
    const body = await response.json()
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
    return normalizeWallets(infos.map((info) => ({
      currency: info?.currency,
      total: info?.total_balance,
      recharged: info?.topped_up_balance,
      granted: info?.granted_balance,
    })))
  } catch {
    return null
  }
}

async function accountBalance(ctx, locale) {
  const account = ctx.get('deepseekAccount')
  if (account === undefined || typeof account.getBalance !== 'function') return null
  try {
    const result = await withTimeout(account.getBalance(accountClient(locale)), ACCOUNT_TIMEOUT_MS)
    if (result === null || result?.status !== 'ready') return null
    const wallets = []
    for (const wallet of Array.isArray(result.value) ? result.value : []) {
      wallets.push({ currency: wallet?.currency, total: wallet?.balance, recharged: wallet?.balance })
    }
    for (const wallet of Array.isArray(result.bonusWallets) ? result.bonusWallets : []) {
      wallets.push({ currency: wallet?.currency, total: wallet?.balance, granted: wallet?.balance })
    }
    return normalizeWallets(wallets)
  } catch {
    return null
  }
}

let balance = { at: 0, wallets: null, failures: 0, nextAt: 0, loading: null }

function balanceBackoff(failures) {
  return Math.min(BALANCE_BACKOFF_MAX_MS, 30_000 * 2 ** Math.min(failures - 1, 10))
}

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
      timer.unref?.()
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

let balanceGen = 0
let balanceController = null

async function loadBalance(ctx, locale, force = false) {
  if (disposed) return balance
  const now = Date.now()
  if (!force) {
    if (balance.wallets !== null && now - balance.at < BALANCE_TTL_MS) return balance
    if (now < balance.nextAt) return balance
  }
  if (balance.loading !== null) {
    if (!force) return balance.loading
    // 手动刷新：中止在途请求，旧结果按代次丢弃
    if (balanceController !== null) balanceController.abort()
  }
  const gen = ++balanceGen
  const controller = new AbortController()
  balanceController = controller
  const untrack = trackAbort(controller)
  const attempt = (async () => {
    let wallets = null
    try {
      wallets = (await accountBalance(ctx, locale)) || (await apiKeyBalance(ctx, controller.signal))
    } catch {
      wallets = null
    }
    untrack()
    if (disposed || gen !== balanceGen) return balance
    if (wallets !== null) {
      balance = { at: Date.now(), wallets, failures: 0, nextAt: 0, loading: null }
    } else {
      const failures = balance.failures + 1
      balance = {
        at: balance.at,
        wallets: balance.wallets,
        failures,
        nextAt: Date.now() + balanceBackoff(failures),
        loading: null,
      }
    }
    poke()
    return balance
  })()
  balance.loading = attempt
  const clear = () => {
    if (balance.loading === attempt) balance.loading = null
  }
  attempt.then(clear, clear)
  return attempt
}

function balanceView(locale) {
  const wallets = balance.wallets
  if (wallets === null || wallets.length === 0) {
    const caption = balance.loading !== null
      ? label(locale, 'balanceLoading')
      : balance.failures > 0
        ? label(locale, 'balanceUnavailable')
        : label(locale, 'balanceUnconfigured')
    return { main: '—', amount: null, caption, tone: 'info' }
  }
  const main = wallets.find((wallet) => wallet.currency === 'CNY') || wallets[0]
  const symbol = main.currency === 'USD' ? '$' : '¥'
  const parts = []
  if (main.granted > 0) parts.push(`${label(locale, 'bonus')} ${symbol}${money(main.granted)}`)
  if (main.recharged > 0) parts.push(`${label(locale, 'recharged')} ${symbol}${money(main.recharged)}`)
  return {
    main: `${symbol}${money(main.total)}`,
    amount: main.total,
    caption: parts.join(' · ') || label(locale, 'balance'),
    tone: main.total < 1 ? 'bad' : main.total < 5 ? 'warn' : 'good',
  }
}

// ── 视图数据 ────────────────────────────────────────────────────────────────

function stripValue(sessionId, locale) {
  scanLogs()
  const session = sessionTotals(sessionId)
  const today = rangeTotals(todayStart(), Date.now() + 1)
  const last = lastTurn(sessionId)
  const items = []
  if (typeof sessionId === 'string' && session.turns > 0) {
    items.push([label(locale, 'stripTurn'), last === null ? 0 : last.costCNY, last === null ? 0 : last.costUSD])
    items.push([label(locale, 'stripChat'), session.costCNY, session.costUSD])
  }
  items.push([label(locale, 'stripToday'), today.costCNY, today.costUSD])
  const render = (list, format) => list.map(([label, cny, usd]) => `${label}${format(cny, usd)}`).join('·')
  let text = render(items, costsText)
  if ([...text].length > 24) text = render(items, costsShort)
  let chosen = items
  while ([...text].length > 24 && chosen.length > 1) {
    chosen = chosen.slice(1)
    text = render(chosen, costsText)
  }
  return { text, icon: 'wallet' }
}

function projectionUsage(sessionId) {
  const sessions = ctxRef?.get?.('sessions')
  const projections = ctxRef?.get?.('sessionProjections')
  if (sessions === undefined || projections === undefined) return null
  const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
  if (session === undefined) return null
  try {
    const usage = projections.snapshot(session)?.values?.tokenUsage
    if (usage === undefined || usage === null) return null
    const input = num(usage.uncachedInputTokens)
    const output = num(usage.outputTokens)
    const cache = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    return { input, output, cache, total: input + output + cache + cacheWrite }
  } catch {
    return null
  }
}

function panelSnapshot(sessionId, locale) {
  const view = balanceView(locale)
  const session = sessionTotals(sessionId)
  const today = rangeTotals(todayStart(), Date.now() + 1)
  const week = rangeTotals(todayStart() - 6 * 86_400_000, Date.now() + 1)
  const rows = []
  const record = typeof sessionId === 'string' ? ledger.get(sessionId) : undefined
  const last = lastTurn(sessionId)
  const model = record?.model || lastModel || 'deepseek-flash'
  const provider = record?.provider || lastProvider || ''
  const price = priceStatus(model, provider, locale)
  const tokens = projectionUsage(sessionId) || {
    input: session.input,
    output: session.output,
    cache: session.cache,
    total: session.total,
  }
  if (record !== undefined && record.turns !== null) {
    for (const [turn, agg] of [...record.turns.entries()].sort((a, b) => b[0] - a[0]).slice(0, 8)) {
      if (turn < 0) continue
      rows.push([
        String(turn),
        agg.model || model,
        compact(agg.input),
        compact(agg.output),
        costsText(agg.costCNY, agg.costUSD),
      ])
    }
  }
  const hint = balance.wallets === null
    ? label(locale, 'hintNoBalance')
    : label(locale, 'hint')
  return {
    balance: view.main,
    balanceCaption: view.caption,
    balanceTone: view.tone,
    todayTotal: compact(today.total),
    todayInput: compact(today.input),
    todayOutput: compact(today.output),
    todayCache: compact(today.cache),
    todayCalls: String(today.calls),
    todayHit: percent(today.cache, today.input + today.cache),
    sessionTotal: compact(tokens.total),
    sessionInput: compact(tokens.input),
    sessionOutput: compact(tokens.output),
    sessionCache: compact(tokens.cache),
    sessionTurns: String(session.turns),
    sessionHit: percent(tokens.cache, tokens.input + tokens.cache),
    weekTotal: compact(week.total),
    sessionCost: costsText(session.costCNY, session.costUSD),
    todayCost: costsText(today.costCNY, today.costUSD),
    weekCost: costsText(week.costCNY, week.costUSD),
    accent: price.accent,
    summaryRows: [
      ...(last === null ? [] : [[label(locale, 'thisTurn'), costsText(last.costCNY, last.costUSD), compact(last.total)]]),
      [label(locale, 'conversation'), costsText(session.costCNY, session.costUSD), compact(tokens.total)],
      [label(locale, 'today'), costsText(today.costCNY, today.costUSD), compact(today.total)],
      [label(locale, 'week'), costsText(week.costCNY, week.costUSD), compact(week.total)],
    ],
    priceRows: price.rows,
    priceNote: price.note,
    priceTitle: price.title,
    rows,
    hint,
  }
}


// ── 插件 ────────────────────────────────────────────────────────────────────

function turnNotes(sessionId) {
  const record = typeof sessionId === 'string' ? ledger.get(sessionId) : undefined
  const notes = {}
  if (record !== undefined) {
    for (const [turn, agg] of record.turns) {
      if (agg.input + agg.output <= 0) continue
      notes[String(turn)] = { text: `↑${compact(agg.input)} ↓${compact(agg.output)}` }
    }
  }
  return notes
}

/** 仅供仓库内测试价格解析。 */
export const __parse = { modelsDev: parseModelsDev, liteLLM: parseLiteLLM, openRouter: parseOpenRouter }

/** 仅供仓库内测试触发一次轮询。 */
export function __tick() {
  tick()
}

/** 仅供仓库内测试读取内部状态，不是公开接口。 */
export function __state() {
  return {
    disposed,
    feeds: feeds.size,
    ticker: ticker !== null,
    tickDelay: nextTickDelay(),
    balance: {
      wallets: balance.wallets === null ? null : balance.wallets.length,
      failures: balance.failures,
      nextAt: balance.nextAt,
      loading: balance.loading !== null,
    },
    remote: {
      count: remote.prices === null ? 0 : Object.keys(remote.prices).length,
      failures: remote.failures,
      nextAt: remote.nextAt,
      loading: remote.loading !== null,
    },
    ledger: {
      sessions: ledger.size,
      hot: [...ledger.values()].filter((record) => record.turns !== null).length,
      cold: coldSessions.size,
      turns: [...ledger.values()].reduce((sum, record) => sum + (record.turns === null ? 0 : record.turns.size), 0),
    },
  }
}

/** 仅供仓库内测试重置模块状态。 */
export function __reset() {
  balanceGen += 1
  if (balanceController !== null) balanceController.abort()
  balanceController = null
  ledger.clear()
  fileState.clear()
  scannedLive.clear()
  coldSessions.clear()
  skipScan.clear()
  lastScan = 0
  scanNote = ''
  lastModel = ''
  lastProvider = ''
  lastModelTime = 0
  balance = { at: 0, wallets: null, failures: 0, nextAt: 0, loading: null }
  remote = { prices: null, at: 0, loading: null, failures: 0, nextAt: 0 }
  disposed = false
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    ctxRef = ctx
    disposed = false
    ctx.effect(() => () => {
      disposeRuntime()
      ctxRef = null
    })

    // 实时累计：引擎每提交一条带用量的回复，就记一笔并通知正在显示的视图
    ctx.on('session/event', (session, event) => {
      if (event === null || typeof event !== 'object') return
      const sessionId = session?.id
      if (event.type === 'request/context') {
        const model = event?.data?.model
        if (typeof model !== 'string' || typeof sessionId !== 'string') return
        const provider = typeof event?.data?.provider === 'string' ? event.data.provider : ''
        let record = ledger.get(sessionId)
        if (record === undefined) {
          record = { origin: '', model: '', provider: '', seqs: new Set(), turns: new Map() }
          ledger.set(sessionId, record)
        }
        if (record.model !== model || (provider !== '' && record.provider !== provider)) {
          record.model = model
          if (provider !== '') record.provider = provider
          lastModel = model
          lastProvider = record.provider
          lastModelTime = Math.max(lastModelTime, num(event.time))
          poke()
        }
        return
      }
      if (event.type !== 'assistant/message') return
      const usage = event?.data?.usage
      if (usage === null || usage === undefined || typeof usage !== 'object') return
      const changed = addUsage(sessionId, session?.origin, event.seq, event?.data?.turn, event.time, usage, event?.data?.model, event?.data?.provider)
      if (changed) poke()
    })

    // 预取一次余额；有缓存和退避，不会重复打接口
    loadBalance(ctx, 'zh-CN').catch(() => {})

    ctx.dshGo.strip('usage', (scope, emit, caps) => {
      let alive = true
      const update = () => {
        if (!alive) return
        scanLogs()
        loadBalance(ctx, caps?.locale)
        emit(stripValue(scope?.sessionId, caps?.locale))
      }
      addFeed(update)
      update()
      return () => {
        alive = false
        removeFeed(update)
      }
    })

    ctx.dshGo.turnNote('turn', (scope, emit) => {
      let alive = true
      const update = () => {
        if (!alive) return
        scanLogs()
        emit(turnNotes(scope?.sessionId))
      }
      addFeed(update)
      update()
      return () => {
        alive = false
        removeFeed(update)
      }
    })

    ctx.dshGo.panel('stats', {
      view: (scope, caps) => panelView(caps?.locale),
      data: (scope, emit, caps) => {
        let alive = true
        const update = () => {
          if (!alive) return
          scanLogs()
          loadBalance(ctx, caps?.locale)
          emit(panelSnapshot(scope?.sessionId, caps?.locale))
        }
        addFeed(update)
        update()
        return () => {
          alive = false
          removeFeed(update)
        }
      },
      actions: {
        refresh: async (scope, event) => {
          scanLogs(true)
          await loadBalance(ctx, event?.locale, true)
          poke()
          return { refresh: true, toast: label(event?.locale, 'refreshed') }
        },
        prices: (scope, event) => {
          refreshPrices()
          return { toast: label(event?.locale, 'priceRefreshed') }
        },
      },
    })
  })
}
