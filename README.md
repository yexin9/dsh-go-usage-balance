# dsh-go-usage-balance

给 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 的原生小插件：**余额 + token 用量 + 花费估算**。

- **输入框上方状态条**：`¥36.95 · 本对话 24.9M`，点开面板
- **面板**：余额；`项目 / 花费 / tokens` 三列表格（本次、本对话、今日、近 7 天）；「明细」折叠区里是本对话与今日的输入/输出/缓存/命中率、价目表、最近 8 轮
- **每条回复的脚注**：`↑94k ↓65.8k`
- **整块面板随 DeepSeek 峰谷价变色**：空闲时段绿色浅底，高峰时段橙色浅底
- 切换模型（`deepseek-flash` / `deepseek-v4-pro`）后，价目和后续花费立即按新模型计算；已产生的话费保持当时价格

## 数据来源

- **余额**：优先用本机保存的 `DEEPSEEK_API_KEY` 查询 `https://api.deepseek.com/user/balance`（结果缓存 5 分钟）；拿不到再用本机 DeepSeek 账号登录态。密钥只留在本机，不发往别处。
- **用量**：只读本机会话日志（`$DSH_HOME/sessions`），不估算、不联网。
- **花费**：估算，**不是账单**。
  - DeepSeek（`deepseek-flash` / `deepseek-v4-pro`）：按 [官方价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 计人民币，高峰时段为北京时间工作日 9:00-12:00、14:00-18:00，价格翻倍；法定节假日未单独判断。价目在 `lib/index.js` 的 `PRICES`。
  - GPT / Gemini / Claude 等其他模型：直接读 pi-ai 自带的模型目录（`@earendil-works/pi-ai/dist/providers/data`）里的美元价，新模型随目录更新自动生效，不用改代码。
  - 两种货币分别显示（例如 `¥1.20+$0.35`），不换算。目录里查不到的模型（一般是自己接的中转）不计花费，面板会标「价目未收录」。

统计口径：子智能体算进「今日」，不算「本对话」；日期按主机本地时区分天。第一次打开面板会扫一遍历史会话（几秒），之后只读变过的日志。

## 安装

手机本机引擎自带 dsh-go 桥接，直接装：

```sh
dsh plugin --profile web add github:yexin9/dsh-go-usage-balance
```

远程主机（服务器 / PC）先用 dsh-go 的安装器装好桥接，再装本插件，否则没有原生界面。

装完在 App 里切一下主机（或重开 App）让它重读插件清单。

## 开发

```sh
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load
```

## 兼容

- DSH `0.2.1-rc.2` ~ `0.2.x`；在 DSH 0.2.2-rc.1 上实测
- Node 22.19+（用到 `zlib` 的 zstd 解码）
- 需要 dsh-go 原生界面桥接（App 1.3.0 / bridge 0.4.0 实测）
- 经 DSH Remote 连接时不显示原生界面

## License

MIT
