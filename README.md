# dsh-go-usage-balance

给 [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 的原生插件：**余额 + token 用量 + 花费估算**。

装上以后，输入框上方多一条状态条，对话「插件」页里多一个面板，每条回复底下多一行用量脚注。DeepSeek 模型的面板会跟着峰谷价变色，切换模型后价格与花费立刻按新模型重算。

> 数据都在本机：用量读本机会话日志，余额只查 DeepSeek 官方接口，不采集、不上传、没有遥测。

## 功能

| 位置 | 内容 |
|---|---|
| 输入框上方状态条 | `本次¥0.08·对话¥2.60·今日¥1.06`，点一下打开面板 |
| 面板 | 余额 + `项目 / 花费 / tokens` 表格（本次、本对话、今日、近 7 天） |
| 面板「明细」 | 本对话与今日的输入 / 输出 / 缓存 / 命中率 / 请求数、当前模型价目、最近 8 轮（含每轮模型名） |
| 每条回复脚注 | `↑94k ↓65.8k`（这一轮的输入 / 输出 token） |
| 整块面板配色 | DeepSeek 空闲时段绿色底、高峰橙色底；其他模型蓝色底；查不到价灰底 |

说明：

- **本次** = 最近一轮回复；**对话** = 本对话累计；**今日** = 本机所有会话当天累计。
- 状态条上限 24 字，放不下时先把花费缩成一位小数，再不行省略「本次」，不截断文字。
- 面板跟随 App 语言显示中文或英文（`caps.locale`），单位、表头、提示都会切换。
- 面板底部两个按钮：**刷新**（重取余额和日志）与 **价目**（强制重新拉取远程价目表）。
- 统一 15 秒轮询，新事件到达时立即刷新，不用等下一次。

## 数据与口径

### token 用量

- 当前会话优先读引擎已有的 `tokenUsage` 投影（`ctx.sessionProjections`），和历史统计口径一致。
- 其他会话按会话日志增量统计，只读变过的文件；活跃会话的日志只解压一次，之后靠实时事件累加。单个日志超过 16 MB 会跳过并提示，避免一次性解压占用过多内存。
- 超过 8 天没使用、也不在运行中的会话会折叠成一条汇总（总量、花费、轮数），不再保留逐轮明细和去重序号；重新打开时用汇总做基线，只累加新事件。
- 子智能体计入「今日」，不计入「本对话」；日期按主机本地时区划分。

### 余额

- 优先复用 DSH 的账号服务（`ctx.deepseekAccount`）取余额；账号未登录或超时（6 秒）时，退回本机 `DEEPSEEK_API_KEY` 查询 `https://api.deepseek.com/user/balance`。
- 成功结果缓存 5 分钟；接口失败按指数退避重试，期间继续显示上一次的值。
- 其他 API 服务商（OpenRouter、new-api 等）的余额不在本插件范围内。

### 花费（估算，不是账单）

| 模型 | 币种 | 计价 |
|---|---|---|
| `deepseek-flash` | 人民币 | 官方价：输入未命中 ¥1、命中 ¥0.02、输出 ¥4（每百万 tokens）；工作日 9:00-12:00、14:00-18:00 高峰价翻倍 |
| `deepseek-v4-pro` | 人民币 | 输入未命中 ¥4.5、命中 ¥0.15、输出 ¥13.5（高峰翻倍） |
| GPT / Gemini / Claude 等 | 美元 | pi-ai 目录 → models.dev（官方提供方优先，转售商只兜底）→ LiteLLM → OpenRouter，多源合并去重 |
| 目录里都没有 | — | 面板标「价目未收录」，不计花费 |

- 人民币和美元分别显示、分别累计（例如 `今日 ¥1.20+$0.35`），不做汇率换算。
- 目录价提供缓存写入单价时会计入（Anthropic 等）；阶梯价按基础档估算。
- 法定节假日按工作日处理，高峰判断可能偏高。
- DeepSeek 价目写在 `lib/index.js` 的 `PRICES`，官方调价时改这里；自定义模型也可以直接在 `PRICES` 里加一条。
- 合并后约 7200 条、加载后约占 4 MB 内存，且只有遇到非 DeepSeek 模型时才加载；纯 DeepSeek 用户不产生这笔开销。
- 拉价目只是下载公开 JSON，不会把模型名或本机信息发出去。

## 轮询与稳定性

- **单一定时器 + 空闲降频**：所有视图共用一个定时器；有活动时 15 秒一轮，安静 2 分钟后自动降到 60 秒一轮；第一个视图出现时启动、最后一个关闭时停止，`unref()` 不阻止进程退出。
- **生命周期清理**：插件卸载时清掉定时器、丢弃订阅、中止进行中的请求（`AbortController`），不留后台任务；视图关闭后订阅数归零，定时器随之停止。
- **刷新竞态**：手动「刷新」会中止在途的余额请求并强制重取，旧请求的结果按代次丢弃，不会覆盖新值，也不会堆积请求。
- **缓存与自动更新**：余额 5 分钟、价目 24 小时（过期由轮询自动后台刷新，也可点「价目」按钮强制）、日志按 mtime 增量、目录 1 分钟内不重复扫描。
- **失败退避**：余额从 30 秒起、每次翻倍、10 分钟封顶；远程价目从 30 秒起、每次翻倍、6 小时封顶；同一时刻各只有一个请求。
- **不误报**：余额区分「查询中 / 暂不可用 / 未配置」，价目区分「查询中 / 未收录」，有缓存值时继续显示旧值；余额字段缺失或解析异常显示「—」，绝不伪装成 ¥0.00。
- **兜底有边界**：账号服务 6 秒超时；直连余额接口 10 秒超时；价目下载 60 秒超时。超时后走失败退避，不无限挂起。

## 安装

手机本机引擎自带 dsh-go 桥接，直接装：

```sh
dsh plugin --profile web add github:yexin9/dsh-go-usage-balance
```

远程主机（服务器 / PC）先用 dsh-go 安装器装好桥接，再装本插件，否则没有原生界面。

装完在 App 里切一下主机（或重开 App），让它重读插件清单。

### 更新

```sh
dsh plugin --profile web add github:yexin9/dsh-go-usage-balance
```

重新执行同一条命令即可拉到最新提交。

### 卸载

```sh
dsh plugin --profile web remove dsh-go-usage-balance
```

缓存文件 `$DSH_HOME/cache/dsh-go-usage-balance/prices.json` 可以直接删。

### 本地开发安装

```sh
dsh plugin --profile web add /path/to/dsh-go-usage-balance
```

## 常见问题

**状态条没出现？**
确认当前主机是手机本机引擎（有桥接）。切一下主机或重开 App；面板在对话详情页的「插件」页签，或「全部功能」里。

**余额一直是「暂不可用」？**
说明 API Key 和 DeepSeek 账号都没取到余额，检查网络或账号登录；插件会按退避自动重试，不用手动刷新。

**花费显示 ¥0.00 或「价目未收录」？**
这个模型不在 DeepSeek 价目、pi-ai 目录、models.dev、LiteLLM 和 OpenRouter 里。等自动拉取完成，或者在 `PRICES` 里手动加一条。

**花费和官方账单对不上？**
估算值：缓存读写、高峰时段、节假日、阶梯计价、中转加价都会造成差异，以账单为准。

**出现两条状态条？**
同时装了新旧两个插件。卸载旧的 `local-usage-balance` 即可。

## 隐私

- 只读本机会话日志和凭据服务里的 `DEEPSEEK_API_KEY`，不上传任何内容。
- 唯一的业务请求是 DeepSeek 余额接口，请求只发往 `api.deepseek.com`。
- 价目表请求只下载公开 JSON 文件，URL 里不带任何模型名或设备信息。
- 无遥测、无第三方统计。

## 兼容

- DSH `0.2.1-rc.2` ~ `0.2.x`，在 `0.2.2-rc.1` 上实测
- Node 22.19+（用到 `zlib` 的 zstd 解码）
- dsh-go App 1.3.0 / bridge 0.4.0 实测；经 DSH Remote 连接时不显示原生界面
- 状态条、面板、回合脚注需要 dsh-go 桥接；没有桥接的主机上插件不显示（本插件不提供工具卡）

## 开发

```sh
npm test                                            # 仓库自带测试
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load   # dsh-go 插件自查
```

`npm test` 覆盖 15 个行为：

| 测试 | 验证点 |
|---|---|
| 状态条按 本次/对话/今日 输出 | 文案格式、24 字上限 |
| 当前会话优先复用 tokenUsage 投影 | 不重复自己算 token |
| 余额优先走 DSH 账号服务 | 生态服务优先于直连 |
| 余额连续失败进入退避 | 失败次数、下次重试时间、不误报 |
| 远程价目失败进入退避 | 两个源各打一次后停止，退避期内不重发 |
| 手动刷新中止在途请求 | 旧结果不覆盖新值 |
| 余额字段缺失 | 显示「—」而不是 ¥0.00 |
| 冷会话折叠 | 汇总保留、明细释放、重开后继续累计 |
| 英文环境 | 面板与状态条切换英文 |
| 逐轮模型 | 每轮记录完整模型名 |
| 价目按钮 | 强制重拉并更新 |
| 缓存写入计费 | 目录提供 cacheWrite 价时计入 |
| 价目过期自动刷新 | 超过 24 小时的本地缓存会在后台重拉 |
| models.dev 官方优先 | 同名模型不取转售商价格 |
| 卸载后清掉定时器与订阅 | 无僵尸轮询 |

代码分三块：`lib/index.js`（价目与目录、用量账本、余额、轮询与插件入口）、`lib/view.js`（面板组件树）、`lib/i18n.js`（中英文案）。改了 `lib/` 里的代码后需要在 App 的「引擎」页重启引擎才生效；改 `package.json` 清单会自动重读。

## English

A native dsh-go plugin showing DeepSeek balance, token usage and estimated cost: a status strip (`this turn / this chat / today`), a panel with balance, per-model prices and recent turns, and a per-reply token note. Costs are estimates: DeepSeek uses official peak/off-peak CNY prices, other models use pi-ai, models.dev, LiteLLM and OpenRouter catalog prices in USD, refreshed every 24 hours. All data stays on the device; only the DeepSeek balance endpoint and a static price JSON are fetched. Install with `dsh plugin --profile web add github:yexin9/dsh-go-usage-balance`.

## License

MIT
