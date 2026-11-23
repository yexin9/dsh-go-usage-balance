// 面板视图（纯数据驱动的组件树），由 lib/index.js 注入数据；文案跟随 App 语言。
import { label } from './i18n.js'

export function panelView(locale) {
  const t = (key) => label(locale, key)
  return {
    type: 'stack',
    v: 2,
    title: t('panelTitle'),
    accent: { $: 'data.accent' },
    style: { background: { $: 'data.accent' }, padding: 'M', gap: 'M' },
    children: [
      {
        type: 'keyValue',
        items: [{ label: t('balance'), value: { $: 'data.balance' }, tone: { $: 'data.balanceTone' } }],
      },
      {
        type: 'table',
        columns: [t('item'), { label: t('cost'), align: 'end' }, { label: t('tokens'), align: 'end' }],
        rows: { $: 'data.summaryRows' },
      },
      {
        type: 'collapsible',
        label: t('detail'),
        expanded: false,
        children: [
          { type: 'text', text: t('conversation'), tone: 'muted' },
          {
            type: 'keyValue',
            items: [
              [t('input'), { $: 'data.sessionInput' }],
              [t('output'), { $: 'data.sessionOutput' }],
              [t('cache'), { $: 'data.sessionCache' }],
              [t('hitRate'), { $: 'data.sessionHit' }],
              [t('turns'), { $: 'data.sessionTurns' }],
            ],
          },
          { type: 'text', text: t('today'), tone: 'muted' },
          {
            type: 'keyValue',
            items: [
              [t('input'), { $: 'data.todayInput' }],
              [t('output'), { $: 'data.todayOutput' }],
              [t('cache'), { $: 'data.todayCache' }],
              [t('hitRate'), { $: 'data.todayHit' }],
              [t('requests'), { $: 'data.todayCalls' }],
            ],
          },
          { type: 'text', text: { $: 'data.priceTitle' }, tone: 'muted' },
          {
            type: 'table',
            columns: [t('item'), { label: t('input'), align: 'end' }, { label: t('cache'), align: 'end' }, { label: t('output'), align: 'end' }],
            rows: { $: 'data.priceRows' },
          },
          {
            type: 'table',
            columns: [t('round'), t('model'), { label: t('input'), align: 'end' }, { label: t('output'), align: 'end' }, { label: t('cost'), align: 'end' }],
            rows: { $: 'data.rows' },
          },
          { type: 'callout', text: { $: 'data.hint' }, tone: 'info' },
        ],
      },
      { type: 'text', text: { $: 'data.priceNote' }, style: { size: 'caption', color: 'gray' } },
      {
        type: 'actions',
        items: [
          { label: t('refresh'), action: 'refresh', icon: 'refresh' },
          { label: t('priceRefresh'), action: 'prices', icon: 'coin' },
        ],
      },
    ],
  }
}
