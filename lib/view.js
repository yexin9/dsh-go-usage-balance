// 面板视图（纯数据驱动的组件树），由 lib/index.js 注入数据。
export function panelView() {
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
          { type: 'text', text: { $: 'data.priceTitle' }, tone: 'muted' },
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
