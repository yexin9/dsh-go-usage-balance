# dsh-go-usage-balance

给 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 的原生小插件：**余额 + token 用量 + 花费估算**。

- **输入框上方状态条**：`本次¥0.08·对话¥2.60·今日¥1.06`，点开面板
- **面板**：余额；`项目 / 花费 / tokens` 三列表格（本次、本对话、今日、近 7 天）；「明细」折叠区里是本对话与今日的输入/输出/缓存/命中率、价目表、最近 8 轮
- **每条回复的脚注**：`↑94k ↓65.8k`
- **整块面板随 DeepSeek 峰谷价变色**：空闲时段绿色浅底，高峰时段橙色浅底
- 切换模型（`deepseek-flash` / `deepseek-v4-pro`）后，价目和后续花费立即按新模型计算；已产生的话费保持当时价格

## 轮询与取数

- 所有视图共用一个定时器（15 秒），第一个视图出现时启动、最后一个视图关闭时停止；插件卸载时清掉定时器并中止进行中的请求，不留后台任务。
- 余额：成功结果缓存 5 分钟；失败按指数退避重试（1→2→4→8→16→30 分钟封顶），有旧值时继续显示旧值，不刷「失败」打扰。同一时刻只允许一个请求。
- 远程价目：单次拉取、成功后缓存 7 天，失败按 5 分钟→6 小时退避；拉取期间面板显示「价目查询中…」，不误报未收录。
- 用量：当前会话优先读引擎已有的 `tokenUsage` 投影（`ctx.sessionProjections`）；活跃会话的日志只在第一次扫描，之后靠 `session/event` 增量，不重复解压。
- 历史/其他会话按文件 mtime 增量扫描，1 分钟内不重复扫目录。

## 数据来源

- **余额**：优先用本机保存的 `DEEPSEEK_API_KEY` 查询 `https://api.deepseek.com/user/balance`（结果缓存 5 分钟）；拿不到再用本机 DeepSeek 账号登录态。密钥只留在本机，不发往别处。
- **用量**：只读本机会话日志（`$DSH_HOME/sessions`），不估算、不联网。
- **花费**：估算，**不是账单**。
  - DeepSeek（`deepseek-flash` / `deepseek-v4-pro`）：按 [官方价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 计人民币，高峰时段为北京时间工作日 9:00-12:00、14:00-18:00，价格翻倍；法定节假日未单独判断。价目在 `lib/index.js` 的 `PRICES`。
  - GPT / Gemini / Claude 等其他模型：先读 pi-ai 自带的模型目录（`@earendil-works/pi-ai/dist/providers/data`）的美元价；目录里没有的，再自动拉 [LiteLLM 公开价目表](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)（7000+ 模型），缓存 7 天到 `$DSH_HOME/cache/dsh-go-usage-balance/prices.json`。拉到价目后，之前查不到价的轮次会自动补算。
  - 两种货币分别显示（例如 `¥1.20+$0.35`），不换算。两处都查不到的模型（自建中转私有的名字）才不计花费，面板标「价目未收录」，可以手动告诉我加。
  - 拉价目只是下载一个公开 JSON 文件，不会把模型名或任何本机信息发出去。

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
