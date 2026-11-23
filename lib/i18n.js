// 界面文案：dsh-go 的 caps.locale 决定用哪套。英文只影响面板文字，数据口径不变。
const ZH = {
  panelTitle: '用量与余额',
  stripTurn: '本次',
  stripChat: '对话',
  stripToday: '今日',
  balance: '余额',
  thisTurn: '本次',
  conversation: '本对话',
  today: '今日',
  week: '近 7 天',
  cost: '花费',
  tokens: 'tokens',
  input: '输入',
  output: '输出',
  cache: '缓存',
  hitRate: '命中率',
  turns: '轮次',
  requests: '请求',
  detail: '明细',
  item: '项目',
  round: '回合',
  model: '模型',
  priceTitleCny: '价目（元 / 百万 tokens）',
  priceTitleUsd: '价目（美元 / 百万 tokens）',
  priceMissingTitle: '价目（未收录）',
  idlePrice: '空闲价',
  peakPrice: '高峰价',
  standardPrice: '标准价',
  balanceLoading: '余额查询中…',
  balanceUnavailable: '余额暂不可用，稍后自动重试',
  balanceUnconfigured: '余额未配置',
  balanceMissing: '余额查不到',
  recharged: '充值',
  bonus: '赠送',
  tokenUnit: 'tokens',
  refresh: '刷新',
  priceRefresh: '价目',
  refreshed: '已刷新',
  priceRefreshed: '价目已更新',
  priceSourcePi: 'pi-ai 目录价',
  priceSourceLite: 'LiteLLM 价目',
  priceQuerying: '价目查询中…',
  priceNotListed: '价目未收录（不计花费）',
  hintNoBalance: '余额查不到：确认已登录 DeepSeek 账号，或在本机保存了 API Key。花费是估算，不是账单。',
  hint: '花费是估算：DeepSeek 按官方峰谷价（人民币），GPT / Gemini 等按 pi-ai 目录价（美元），未收录的模型不计花费。子智能体算「今日」，不算「本对话」。',
  todayInput: '今日输入',
  todayOutput: '今日输出',
  todayCache: '今日缓存',
  todayHit: '今日命中率',
  todayRequests: '今日请求',
  weekCost: '近 7 天花费',
}

const EN = {
  panelTitle: 'Usage & balance',
  stripTurn: 'Turn',
  stripChat: 'Chat',
  stripToday: 'Today',
  balance: 'Balance',
  thisTurn: 'This turn',
  conversation: 'This chat',
  today: 'Today',
  week: '7 days',
  cost: 'Cost',
  tokens: 'tokens',
  input: 'Input',
  output: 'Output',
  cache: 'Cache',
  hitRate: 'Hit rate',
  turns: 'Turns',
  requests: 'Requests',
  detail: 'Details',
  item: 'Item',
  round: 'Turn',
  model: 'Model',
  priceTitleCny: 'Price (CNY / 1M tokens)',
  priceTitleUsd: 'Price (USD / 1M tokens)',
  priceMissingTitle: 'Price (not listed)',
  idlePrice: 'Off-peak',
  peakPrice: 'Peak',
  standardPrice: 'Standard',
  balanceLoading: 'Checking balance…',
  balanceUnavailable: 'Balance unavailable, retrying later',
  balanceUnconfigured: 'Balance not configured',
  balanceMissing: 'No balance',
  recharged: 'Recharged',
  bonus: 'Bonus',
  tokenUnit: 'tokens',
  refresh: 'Refresh',
  priceRefresh: 'Prices',
  refreshed: 'Refreshed',
  priceRefreshed: 'Prices updated',
  priceSourcePi: 'pi-ai catalog',
  priceSourceLite: 'LiteLLM prices',
  priceQuerying: 'Looking up price…',
  priceNotListed: 'Price not listed (not counted)',
  hintNoBalance: 'No balance found: sign in to DeepSeek or save an API key. Costs are estimates, not a bill.',
  hint: 'Costs are estimates: DeepSeek uses official peak/off-peak prices in CNY; GPT / Gemini etc. use pi-ai catalog prices in USD; models without a price are not counted. Subagents count for today, not for this chat.',
  todayInput: 'Today input',
  todayOutput: 'Today output',
  todayCache: 'Today cache',
  todayHit: 'Today hit rate',
  todayRequests: 'Today requests',
  weekCost: '7-day cost',
}

const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六']

export function langOf(locale) {
  return String(locale ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh'
}

export function label(locale, key) {
  return (langOf(locale) === 'en' ? EN : ZH)[key]
}

/** 下一个峰谷切换点的文案，例如「12:00 转空闲价」「to off-peak at 12:00」。 */
export function switchText(locale, at, toPeak, nowMs) {
  const when = new Date(at + 8 * 3_600_000)
  const now = new Date(nowMs + 8 * 3_600_000)
  const hh = `${String(when.getUTCHours()).padStart(2, '0')}:00`
  const same = (a, b) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()
  const en = langOf(locale) === 'en'
  let day
  if (same(when, now)) day = ''
  else if (same(when, new Date(now.getTime() + 86_400_000))) day = en ? 'tomorrow ' : '明天 '
  else day = en ? `${WEEKDAYS_EN[when.getUTCDay()]} ` : `周${WEEKDAYS_ZH[when.getUTCDay()]} `
  if (en) return `to ${toPeak ? 'peak' : 'off-peak'} at ${day}${hh}`
  return `${day}${hh} 转${toPeak ? '高峰' : '空闲'}价`
}
