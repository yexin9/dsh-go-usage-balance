// dsh-go-usage-balance —— 给 dsh-go 手机 App 的原生插件：
// 输入框上方的状态条（余额 + 本对话 token）、对话「插件」页签里的面板、每条回复的用量脚注。
// 余额优先读本机保存的 DeepSeek API Key 查询官方余额接口，查不到再用本机 DeepSeek 账号；
// 用量全部来自本机会话日志，不估算、不联网。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-go-usage-balance'

const LOG_FILE = 'session.v4.jsonl.zstd'
const SCAN_THROTTLE_MS = 60_000
const BALANCE_TTL_MS = 5 * 60_000
const TICK_MS = 15_000
const MAX_LOG_BYTES = 48 * 1024 * 1024
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** DeepSeek 官方价目（元 / 百万 tokens）：空闲价与高峰价。 */
const PRICES = {
  'deepseek-flash': { hitIdle: 0.02, hitPeak: 0.04, missIdle: 1, missPeak: 2, outIdle: 4, outPeak: 8 },
  'deepseek-v4-pro': { hitIdle: 0.15, hitPeak: 0.30, missIdle: 4.5, missPeak: 9, outIdle: 13.5, outPeak: 27 },
}
const DEFAULT_PRICE = PRICES['deepseek-flash']

/** 北京时间工作日 9:00-12:00、14:00-18:00 是高峰时段，其余为空闲时段。 */
function isPeak(ms) {
  const date = new Date(num(ms) + 8 * 3_600_000)
  const hour = date.getUTCHours()
  const day = date.getUTCDay()
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}

/** 按官方价目估算一次调用的费用（元）。缓存写入官方不单独收费。 */
function usageCost(usage, model, time) {
  const price = PRICES[model] || DEFAULT_PRICE
  const peak = isPeak(time)
  const hit = peak ? price.hitPeak : price.hitIdle
  const miss = peak ? price.missPeak : price.missIdle
  const out = peak ? price.outPeak : price.outIdle
  return (num(usage.inputTokens) * miss + num(usage.cacheReadTokens) * hit + num(usage.outputTokens) * out) / 1e6
}

/** 数字按价目显示：去掉多余的小数位（0.02、1、4.5）。 */
function priceNumber(n) {
  return String(Number(Number(n).toFixed(3)))
}

/** 当前模型的空闲价与高峰价文案。 */
function priceLabels(model) {
  const price = PRICES[model] || DEFAULT_PRICE
  const known = Object.hasOwn(PRICES, model || '')
  const line = (miss, hit, out) => `入¥${priceNumber(miss)} · 存¥${priceNumber(hit)} · 出¥${priceNumber(out)}`
  return {
    known,
    idle: line(price.missIdle, price.hitIdle, price.outIdle),
    peak: line(price.missPeak, price.hitPeak, price.outPeak),
  }
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

function boundaryLabel(next, nowMs) {
  const when = new Date(next.at + 8 * 3_600_000)
  const now = new Date(nowMs + 8 * 3_600_000)
  const hh = `${String(when.getUTCHours()).padStart(2, '0')}:00`
  const same = (a, b) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()
  if (same(when, now)) return hh
  if (same(when, new Date(now.getTime() + 86_400_000))) return `明天 ${hh}`
  return `周${'日一二三四五六'[when.getUTCDay()]} ${hh}`
}

function priceStatus(model) {
  const now = Date.now()
  const peak = isPeak(now)
  const next = nextBoundary(now)
  const name = model || 'deepseek-flash'
  const labels = priceLabels(name)
  const price = PRICES[name] || DEFAULT_PRICE
  const when = next === null ? '' : `${boundaryLabel(next, now)} 转${next.peak ? '高峰' : '空闲'}价`
  return {
    peak,
    accent: peak ? 'orange' : 'green',
    short: name.replace(/^deepseek-/, ''),
    known: labels.known,
    when,
    labels,
    cells: {
      idle: [`¥${priceNumber(price.missIdle)}`, `¥${priceNumber(price.hitIdle)}`, `¥${priceNumber(price.outIdle)}`],
      peak: [`¥${priceNumber(price.missPeak)}`, `¥${priceNumber(price.hitPeak)}`, `¥${priceNumber(price.outPeak)}`],
    },
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
const pokes = new Set()

let lastScan = 0
let scanNote = ''
let balance = { at: 0, wallets: null }
let lastModel = ''
let lastModelTime = 0
let balanceLoading = null

// ── 用量账本 ────────────────────────────────────────────────────────────────

function addUsage(sessionId, origin, seq, turn, time, usage, model) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  let record = ledger.get(sessionId)
  if (record === undefined) {
    record = { origin: '', model: '', turns: new Map(), seqs: new Set() }
    ledger.set(sessionId, record)
  }
  if (typeof origin === 'string' && origin !== '' && record.origin === '') record.origin = origin
  if (typeof model === 'string' && model !== '') record.model = model
  const key = typeof seq === 'number' ? seq : `t${String(time)}`
  if (record.seqs.has(key)) return false
  record.seqs.add(key)
  const turnNo = typeof turn === 'number' ? turn : 0
  let agg = record.turns.get(turnNo)
  if (agg === undefined) {
    agg = { time: 0, input: 0, output: 0, cache: 0, total: 0, cost: 0, calls: 0 }
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
  agg.cost += usageCost(usage, model || record.model, time)
  agg.calls += 1
  return true
}

function scanLogs(force = false) {
  const now = Date.now()
  if (!force && now - lastScan < SCAN_THROTTLE_MS) return
  lastScan = now
  const root = join(dshHome(), 'sessions')
  let groups
  try {
    groups = readdirSync(root, { withFileTypes: true })
  } catch {
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
      } catch {
        // 引擎还在写这个文件，下次再读
      }
    }
  }
}

function parseLog(file, text) {
  let id = ''
  let origin = ''
  let model = ''
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
        if (num(event.time) > lastModelTime) {
          lastModelTime = num(event.time)
          lastModel = model
        }
      }
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event?.data?.usage
    if (usage === undefined || usage === null || typeof usage !== 'object') continue
    addUsage(id || basename(dirname(file)), origin, event.seq, event?.data?.turn, event.time, usage, model)
  }
}

function emptyTotals() {
  return { input: 0, output: 0, cache: 0, total: 0, cost: 0, calls: 0, turns: 0 }
}

function sessionTotals(sessionId) {
  const totals = emptyTotals()
  if (typeof sessionId !== 'string') return totals
  const record = ledger.get(sessionId)
  if (record === undefined) return totals
  for (const agg of record.turns.values()) {
    totals.input += agg.input
    totals.output += agg.output
    totals.cache += agg.cache
    totals.total += agg.total
    totals.cost += agg.cost
    totals.calls += agg.calls
    totals.turns += 1
  }
  return totals
}

function rangeTotals(from, to) {
  const totals = emptyTotals()
  for (const record of ledger.values()) {
    for (const agg of record.turns.values()) {
      if (agg.time < from || agg.time >= to) continue
      totals.input += agg.input
      totals.output += agg.output
      totals.cache += agg.cache
      totals.total += agg.total
      totals.cost += agg.cost
      totals.calls += agg.calls
      totals.turns += 1
    }
  }
  return totals
}

function lastTurn(sessionId) {
  if (typeof sessionId !== 'string') return null
  const record = ledger.get(sessionId)
  if (record === undefined || record.turns.size === 0) return null
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

function costText(value) {
  const n = amount(value)
  if (!(n > 0)) return '¥0.00'
  return n < 0.01 ? `¥${n.toFixed(4)}` : `¥${n.toFixed(2)}`
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

function normalizeWallets(list) {
  const byCurrency = new Map()
  for (const wallet of list) {
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

async function apiKeyBalance(ctx) {
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
      signal: AbortSignal.timeout(10_000),
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
    const result = await account.getBalance(accountClient(locale))
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

async function loadBalance(ctx, locale, force = false) {
  if (!force && balance.wallets !== null && Date.now() - balance.at < BALANCE_TTL_MS) return balance
  if (balanceLoading !== null) return balanceLoading
  balanceLoading = (async () => {
    let wallets = null
    try {
      wallets = (await apiKeyBalance(ctx)) || (await accountBalance(ctx, locale))
    } catch {
      wallets = null
    }
    balance = { at: Date.now(), wallets }
    return balance
  })().finally(() => { balanceLoading = null })
  return balanceLoading
}

function balanceView() {
  const wallets = balance.wallets
  if (wallets === null || wallets.length === 0) {
    return { main: '—', amount: null, caption: '余额查不到', tone: 'info' }
  }
  const main = wallets.find((wallet) => wallet.currency === 'CNY') || wallets[0]
  const symbol = main.currency === 'USD' ? '$' : '¥'
  const parts = []
  if (main.granted > 0) parts.push(`赠送 ${symbol}${money(main.granted)}`)
  if (main.recharged > 0) parts.push(`充值 ${symbol}${money(main.recharged)}`)
  return {
    main: `${symbol}${money(main.total)}`,
    amount: main.total,
    caption: parts.join(' · ') || 'DeepSeek 余额',
    tone: main.total < 1 ? 'bad' : main.total < 5 ? 'warn' : 'good',
  }
}

// ── 视图数据 ────────────────────────────────────────────────────────────────

function stripValue(sessionId) {
  scanLogs()
  const session = sessionTotals(sessionId)
  const today = rangeTotals(todayStart(), Date.now() + 1)
  const last = lastTurn(sessionId)
  const withSession = typeof sessionId === 'string' && session.turns > 0
  const items = []
  if (withSession) {
    items.push(['本次', last === null ? 0 : last.cost])
    items.push(['对话', session.cost])
  }
  items.push(['今日', today.cost])
  const build = (format) => items.map(([label, value]) => `${label}${format(value)}`).join('·')
  let text = build(costText)
  if ([...text].length > 24) text = build((value) => `¥${amount(value).toFixed(1)}`)
  if ([...text].length > 24 && items.length > 1) {
    const fewer = items.slice(1)
    text = fewer.map(([label, value]) => `${label}${costText(value)}`).join('·')
  }
  return { text, icon: 'wallet' }
}

function panelSnapshot(sessionId) {
  const view = balanceView()
  const session = sessionTotals(sessionId)
  const today = rangeTotals(todayStart(), Date.now() + 1)
  const week = rangeTotals(todayStart() - 6 * 86_400_000, Date.now() + 1)
  const rows = []
  const record = typeof sessionId === 'string' ? ledger.get(sessionId) : undefined
  const last = lastTurn(sessionId)
  const model = record?.model || lastModel || 'deepseek-flash'
  const price = priceStatus(model)
  if (record !== undefined) {
    for (const [turn, agg] of [...record.turns.entries()].sort((a, b) => b[0] - a[0]).slice(0, 8)) {
      rows.push([
        String(turn),
        compact(agg.input),
        compact(agg.output),
        costText(agg.cost),
      ])
    }
  }
  const hint = balance.wallets === null
    ? '余额查不到：确认已登录 DeepSeek 账号，或在本机保存了 API Key。花费按官方价目估算，不是账单。'
    : '花费按 DeepSeek 官方价目估算，不是账单；切到别的模型后，新请求按新模型价计。子智能体算「今日」，不算「本对话」。'
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
    sessionTotal: compact(session.total),
    sessionInput: compact(session.input),
    sessionOutput: compact(session.output),
    sessionCache: compact(session.cache),
    sessionTurns: String(session.turns),
    sessionHit: percent(session.cache, session.input + session.cache),
    weekTotal: compact(week.total),
    sessionCost: costText(session.cost),
    todayCost: costText(today.cost),
    weekCost: costText(week.cost),
    accent: price.accent,
    summaryRows: [
      ...(last === null ? [] : [[ '本次', costText(last.cost), compact(last.total) ]]),
      ['本对话', costText(session.cost), compact(session.total)],
      ['今日', costText(today.cost), compact(today.total)],
      ['近 7 天', costText(week.cost), compact(week.total)],
    ],
    priceRows: [
      ['空闲价', ...price.cells.idle],
      ['高峰价', ...price.cells.peak],
    ],
    priceNote: `当前${price.peak ? '高峰价' : '空闲价'} · ${price.short}${price.known ? '' : '（按 flash 价）'}${price.when === '' ? '' : ` · ${price.when}`}`,
    rows,
    hint,
  }
}

function panelView() {
  return {
    type: 'stack',
    v: 2,
    title: '用量与余额',
    accent: { $: 'data.accent' },
    style: { background: { $: 'data.accent' }, padding: 'M', gap: 'M' },
    children: [
      {
        type: 'keyValue',
        items: [{ label: '余额', value: { $: 'data.balance' }, tone: { $: 'data.balanceTone' } }],
      },
      {
        type: 'table',
        columns: ['项目', { label: '花费', align: 'end' }, { label: 'tokens', align: 'end' }],
        rows: { $: 'data.summaryRows' },
      },
      {
        type: 'collapsible',
        label: '明细',
        expanded: false,
        children: [
          { type: 'text', text: '本对话', tone: 'muted' },
          {
            type: 'keyValue',
            items: [
              ['输入', { $: 'data.sessionInput' }],
              ['输出', { $: 'data.sessionOutput' }],
              ['缓存', { $: 'data.sessionCache' }],
              ['命中率', { $: 'data.sessionHit' }],
              ['轮次', { $: 'data.sessionTurns' }],
            ],
          },
          { type: 'text', text: '今日', tone: 'muted' },
          {
            type: 'keyValue',
            items: [
              ['输入', { $: 'data.todayInput' }],
              ['输出', { $: 'data.todayOutput' }],
              ['缓存', { $: 'data.todayCache' }],
              ['命中率', { $: 'data.todayHit' }],
              ['请求', { $: 'data.todayCalls' }],
            ],
          },
          { type: 'text', text: '价目（元 / 百万 tokens）', tone: 'muted' },
          {
            type: 'table',
            columns: ['时段', { label: '入', align: 'end' }, { label: '存', align: 'end' }, { label: '出', align: 'end' }],
            rows: { $: 'data.priceRows' },
          },
          {
            type: 'table',
            columns: ['回合', { label: '输入', align: 'end' }, { label: '输出', align: 'end' }, { label: '花费', align: 'end' }],
            rows: { $: 'data.rows' },
          },
          { type: 'callout', text: { $: 'data.hint' }, tone: 'info' },
        ],
      },
      { type: 'text', text: { $: 'data.priceNote' }, style: { size: 'caption', color: 'gray' } },
      { type: 'actions', items: [{ label: '刷新', action: 'refresh', icon: 'refresh' }] },
    ],
  }
}

// ── 插件 ────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    // 实时累计：引擎每提交一条带用量的回复，就记一笔并通知正在显示的面板
    ctx.on('session/event', (session, event) => {
      if (event === null || typeof event !== 'object') return
      const sessionId = session?.id
      if (event.type === 'request/context') {
        const model = event?.data?.model
        if (typeof model !== 'string' || typeof sessionId !== 'string') return
        let record = ledger.get(sessionId)
        if (record === undefined) {
          record = { origin: '', model: '', turns: new Map(), seqs: new Set() }
          ledger.set(sessionId, record)
        }
        if (record.model !== model) {
          record.model = model
          lastModel = model
          lastModelTime = Math.max(lastModelTime, num(event.time))
          for (const poke of pokes) poke()
        }
        return
      }
      if (event.type !== 'assistant/message') return
      const usage = event?.data?.usage
      if (usage === null || usage === undefined || typeof usage !== 'object') return
      const changed = addUsage(sessionId, session?.origin, event.seq, event?.data?.turn, event.time, usage, event?.data?.model)
      if (changed) for (const poke of pokes) poke()
    })

    // 插件加载时先查一次余额，状态条第一次出现就有数字
    loadBalance(ctx, 'zh-CN').catch(() => {})

    const refreshAll = () => {
      scanLogs()
      for (const poke of pokes) poke()
    }

    ctx.dshGo.strip('usage', (scope, emit, caps) => {
      let alive = true
      const update = () => {
        if (!alive) return
        scanLogs()
        emit(stripValue(scope?.sessionId))
      }
      pokes.add(update)
      update()
      loadBalance(ctx, caps?.locale).then(update, () => {})
      const timer = setInterval(() => {
        scanLogs()
        loadBalance(ctx, caps?.locale).then(update, () => {})
        update()
      }, TICK_MS)
      return () => {
        alive = false
        clearInterval(timer)
        pokes.delete(update)
      }
    })

    ctx.dshGo.turnNote('turn', (scope, emit) => {
      let alive = true
      const update = () => {
        if (!alive) return
        scanLogs()
        const record = typeof scope?.sessionId === 'string' ? ledger.get(scope.sessionId) : undefined
        const notes = {}
        if (record !== undefined) {
          for (const [turn, agg] of record.turns) {
            if (agg.input + agg.output <= 0) continue
            notes[String(turn)] = { text: `↑${compact(agg.input)} ↓${compact(agg.output)}` }
          }
        }
        emit(notes)
      }
      pokes.add(update)
      update()
      return () => {
        alive = false
        pokes.delete(update)
      }
    })

    ctx.dshGo.panel('stats', {
      view: () => panelView(),
      data: (scope, emit, caps) => {
        let alive = true
        const update = () => {
          if (alive) emit(panelSnapshot(scope?.sessionId))
        }
        pokes.add(update)
        scanLogs()
        update()
        loadBalance(ctx, caps?.locale).then(update, () => {})
        const timer = setInterval(() => {
          scanLogs()
          loadBalance(ctx, caps?.locale).then(update, () => {})
          update()
        }, TICK_MS)
        return () => {
          alive = false
          clearInterval(timer)
          pokes.delete(update)
        }
      },
      actions: {
        refresh: async (scope, event) => {
          scanLogs(true)
          await loadBalance(ctx, event?.locale, true)
          refreshAll()
          return { refresh: true, toast: '已刷新' }
        },
      },
    })
  })
}
