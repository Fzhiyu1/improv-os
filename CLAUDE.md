# ImprovOS（工作名，待定）

一个发布到互联网博大家一笑的体验项目：macOS 风格的网页"操作系统"，壳是手写的，里面所有应用都由 LLM 实时生成。灵感致敬 vibe os。

## 已验证的事实（2026-06-11 实测）

- 上游：任意 Anthropic `/v1/messages` 兼容端点（官方 API 或自建网关），地址/密钥走 `.env` 的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（内部环境细节见 `deploy/INTERNAL.md`，不入库）
  - 模型名 `claude-sonnet-4-6`，**实测 815 tok/s**（2000 token 完整计算器 2.5s）
  - SSE 流式可用；响应先吐 `thinking` block 再吐 `text` block——前端把 thinking 演成"系统思考中…"，text 演成代码瀑布
- key 在 `.env`（已 gitignore），**永不进前端、永不进 git**

## 核心设计决策

1. **壳手写，软件皆生成**：桌面/菜单栏/Dock/窗口管理/Spotlight 搜索是真代码；计算器、备忘录等 Dock 应用**点开即重新生成、永不缓存**（每次长得不一样是核心笑点）
2. **浏览器套娃**：生成一个浏览器应用，里面"访问"的网页也是现编的
3. **只有 Spotlight 搜索召唤出的应用会落盘缓存**（`apps/<slug>/`，文件系统即真相），命中秒开，带 🎲 重新投胎。Dock「应用程序」启动台（`web/js/launchpad.js` + `/api/apps`）网格展示全部缓存应用：确定性图标（名字 hash 渐变 squircle + 关键词 SF 字形，id 唯一化防渐变串色）+ 启发式分类胶囊 + 搜索，点击走 openSearchApp 秒开
4. **双轨生成**：默认单次流式直出自包含 HTML（2-3s，主演出）；可选慢轨走 openCode SDK 智能体循环（"雇佣 AI 工程师"真人秀），不绑架主体验
5. **安全**：key 只在服务端；代理只暴露"按固定 system prompt 生成应用"单一能力；IP 限流 + 全站日熔断；生成物跑 `sandbox="allow-scripts"` iframe；搜索词轻量审核（违规返回"已查封"梗页面）

## 运行时能力桥（Part A，2026-06-11 已上线）

生成应用可调 `window.os`（系统注入 SDK，sandbox iframe 内仍无直接网络）：
- `os.ai.ask(prompt)` → AI 文本应答（固定 system，限定应用场景）
- `os.http.get(url)` → 公网只读 GET。唯一防线是服务端 SSRF 过滤（`server/lib/ssrf.mjs`：私网黑名单 + 协议白名单 + DNS 校验 + 固定 IP 连接防 rebinding + 重定向逐跳重验 + 8s 超时 + 512KB 上限）
- `os.store.*` → 按 appId 命名空间的共享 KV（`apps/_store/`，同名应用所有访客共享；单条 64KB/总量 1MB/100 键）

三层链路：iframe SDK（postMessage，init 握手前排队）→ `web/js/bridge.js`（**只认 registry 登记过的 e.source，忽略自报 appId**）→ `/api/capability/*`（各自限流：ai 20/min、http 30/min、store 120/min，`CAP_*_PER_MIN` 可调）。
appId 命名空间：dock=`app:<id>`，搜索=slug，浏览器=`web:<djb2>`。

⚠️ 实测坑（2026-06-11）：
- **req close ≠ 客户端断开（2026-06-12 事故）**：Node 15+ `IncomingMessage` 的 `close` 在**消息体读完**就触发。GET 没人消费 body 侥幸无感；POST（/api/repair）读完 body 即触发 → `makeSession` 误判断开自杀（掐上游、catch 因 aborted 静默、不发 done/error）→ **修复功能自上线起 100% 卡死且零日志**。断开检测一律挂 `res.on('close')` + `!res.writableEnded`。修复同时补了 genGate（修复曾绕过并发闸）。教训：每条对外链路上线时都要端到端冒烟，"代码看起来对"不算
- **destroy() 不带 error 不发 'error' 事件（2026-06-12 事故）**：访客中途关页面 → res close → `s.current?.destroy()` 杀上游请求，但 destroy 不带参不会触发 'error'，cb 永不执行 → `s.step` 的 Promise 永久 pending → **genGate 并发槽随每次中途断开永久泄漏**（线上待机 fastActive 长期 4/10）。修复：会话记录 step 的 reject，断开时手动 `abortStep(new Error('aborted'))` 摇醒等待者；429 退避窗口加 isAborted 检查不再白烧上游。回归：`tests/slot-leak.e2e.test.mjs`（真服务 + 假流式上游 + 中途掐线断言归零）。教训：杀掉底层资源 ≠ 摇醒上层等待者，凡 destroy 必问"谁在 await 它"
- **.env 加载顺序（2026-06-12 事故）**：ES import 全部提升到模块体之前求值——lib 在模块层读 `process.env`（如 opencode.mjs 的 OC_*）时 .env 还没注入，永远拿默认值。OC_PROVIDER 默认名一改慢轨全断（之前 default==实际值纯属侥幸）。修复：`server/lib/env.mjs` 作为 index.mjs **第一个 import**
- Node 20+ `autoSelectFamily` 以 `all:true` 调自定义 lookup，须返回数组（已修）
- Spotlight"获取/完整版"路径必须传 `/api/search` 返回的 slug，否则 appId 为空、桥不接线（已修）
- open-meteo 被源站网络出口 502 拦截；prompt 内推荐数据源用 wttr.in / exchangerate-api / hacker-news（均实测可达）
- 测试：`node --test 'tests/*.test.mjs'`（16 个，ssrf/store/ratelimit）

## 慢轨真 Agent Loop + 修改应用（Part B，2026-06-11 已上线）

Spotlight"完整版"（mode=deep）与缓存应用"修改"按钮走真正的 openCode agent loop：
- **架构**：opencode 独立常驻（`opencode serve` :4096，systemd `opencode.service`，每日重启防泄漏），improv-os 用**纯 Node http REST**驱动（不引 `@opencode-ai/sdk`，仍零依赖）。`server/lib/opencode.mjs` 是客户端。
- **流程**：创建 session（工作目录 `apps/_agent/`）→ 订阅 `/event` SSE → 下发任务 → agent 写 `app.html` 并用 bash 跑 `verify-html.mjs` 自检迭代 → `session.idle` 后读产物 → injectSys 注入 SDK → 落盘缓存 → 删 session。
- **验证用 node 脚本而非 chromium**（`server/verify-html.mjs`，省 300-500MB 适配 1.9GB）。
- **事件直播**：`server/lib/agent-events.mjs` 把工具调用映射成剧场 stage（"正在编辑文件/正在运行验证"）；文本 part 不直播（part.text 是累积全文会刷屏）。
- **修改应用**：`/api/modify`（POST {slug, instruction}），把现有 index.html 拷进工作目录让 agent 增量编辑，写回缓存。只缓存应用可改（dock 应用每次重生成）。
- **并发限 1**（`server/lib/gate.mjs`），工作目录单一不冲突。
- **挂死防护（2026-06-12，事故驱动）**：一个挂死的 agent 曾占住唯一深轨坑位 22 分钟堵死所有人（02:42 的 modify 无 done、无日志、无超时）。三层修复：① 硬墙钟超时 `DEEP_TIMEOUT_SEC`（默认 150s）`Promise.race` 中止（弃赛侧 promise 必须先 `.catch(()=>{})` 防 unhandled rejection），finally 删会话即终止 opencode 侧运行；② agent 错误全部落 `agent_error` 活动事件（含 timeout 标记，控制台「异常」可见）；③ 启动清扫 `listSessions(AGENT_WORK)` 全删——进程被杀时 finally 不执行，孤儿会话白吃内存。

⚠️ 实测（2026-06-11）：
- 本机 opencode 1.1.53 / 源站 1.17.3，REST 形态兼容（session.id / message.info.finish / /event 一致）。
- 深轨生成 ~16-27s，修改 ~10s。内存：improv+opencode RSS≈583MB，源站可用余量 >1GB。
- 旧伪 agent `generateDeep` 保留为 openCode 不可用时回退（ocHealth 预检）。
- 配置：`deploy/opencode.json`（gateway provider→上游）、`deploy/opencode.service`；key 走 .env 的 ANTHROPIC_AUTH_TOKEN，OC_PORT/OC_PROVIDER/OC_MODEL 也在 .env。

## 公网上线（os.fzhiyu.dev，2026-06-11）

通过 Cloudflare Tunnel 发到公网供大家游玩。源站在内网，cloudflared 反向连 Cloudflare 边缘，源站 7100 不对公网暴露（隐藏源站 IP）。
- **入口**：`https://os.fzhiyu.dev`（`cloudflared.service` systemd 常驻，双边缘连接冗余）
- **后端**：上游网关 Sonnet（源站可直连）。**测试期 token 充足**，故不锁 token、**锁并发**。
- **限流转向**：`DAILY_TOKEN_BUDGET=0`（关，留兜底），核心是并发闸 `GEN_CONCURRENCY=5`/`GEN_QUEUE=24`/`DEEP_QUEUE=8` 保护上游网关不被打爆。
- **全链路实测通**：快轨代码瀑布（长连接 SSE 经 Cloudflare 不缓冲）、深轨完整版（12.9s）、三能力、修改应用。
- **运维坑**：opencode 是 user service，必须 `loginctl enable-linger <部署用户>`（已开），否则部署者登出被杀。
- 部署实操与内部环境见 `deploy/PUBLIC-LAUNCH.md` + `deploy/INTERNAL.md`（均 gitignore 不入库）；凭据（cert.pem/<id>.json）只在源站绝不进 git。

### 反盗用加固（2026-06-12）

审计实锤：发布后烧 token 的接口曾可被任意第三方跨站盗用（伪造 `Origin: evil.com` 调 `/api/generate` 返回 200），且限流取 `x-forwarded-for` 首段可伪造绕过。已加固（`server/lib/origin.mjs` + 12 单测）：
- **同源守卫**：`GUARDED` 接口（generate/modify/repair/capability.*）必须来自本站——有 Origin 校 Origin、否则校 Referer、裸请求拒。挡掉跨站 fetch / iframe 嵌入 / 裸脚本白嫖。能力调用来自父窗口同源（sandbox iframe 走 postMessage）故放行；只读接口（stats/live/apps/search/app）不守卫，健康检查与控制台 publicCheck 不受影响。
- **真实 IP**：限流键改用 Cloudflare 不可伪造的 `cf-connecting-ip`（回退 xff 末段）。
- **安全头**：全响应 `Referrer-Policy: same-origin`（同源带 referer、跨站绝不带，守卫对 GET/SSE 生效的前提）+ `X-Content-Type-Options: nosniff`。
- 盗用尝试记 `origin_block` 进活动日志，内网控制台「异常/限流」实时可见。
- 已实证：裸/evil Origin→403、本站 Referer→200、真实浏览器同源 fetch（generate/cap）全 200 零误杀。可经 `.env ALLOWED_ORIGINS` 加白名单。
- ⚠️ 非绝对防御：决心盗用的脚本可伪造 `Referer: os.fzhiyu.dev` 头绕过——彻底防御需 Cloudflare Access 全站门禁（会改变"发给大家玩"的玩法，未启用）。当前定位：挡顺手盗用 + 修限流绕过，token 无限故损害本就有限。

### 内外网分治（2026-06-12）

公网上线后内网同事的可用性也要保证：**限制外网、放开内网**。
- **判定**（`origin.mjs isLan`）：流量只有两条进路——cloudflared 隧道（必带边缘写入不可伪造的 `cf-connecting-ip`）或内网直连源站端口，故「socket 是私网/回环 且 无 cf 头」⇒ 内网。内网者伪造 cf 头只会自降为公网待遇，无提权方向。
- **内网放开**：免同源守卫（此前内网直连 `http://<内网IP>:7100` 因 Referer 是内网 IP 不在白名单，生成接口 403——本次顺带修复）、免每小时/每日/token 全部限流、免能力桥三限流。
- **内网保底并发**：独立 `lanGate`（`LAN_GEN_CONCURRENCY` 默认 3，队列 16），公网把 genGate 打满也挤不掉内网。上游总并发上限 = GEN + LAN_GEN。慢轨因单工作目录物理限制仍共享 1 并发。
- **不放开的**：内容黑名单内外网一视同仁。
- 观测：`/api/stats`、`/api/live` 带 `lanActive/lanMax`；活动日志 gen/repair 事件带 `lan:1` 标记。
- e2e：`tests/lan.e2e.test.mjs`（内网裸请求放行走 lanGate + 断开释放 + 公网裸请求仍 403）。⚠️ 写本地 e2e 时注意：127.0.0.1 会被判内网，要测公网行为需伪造 cf 头（slot-leak 测试已钉）。

## 手机轻量适配（2026-06-12，方案 A）

手机访问从"全屏劝退页"改为正常进入。纯 CSS（`@media max-width:760px`）+ viewport 禁缩放，无 JS 改动（窗口尺寸用 `!important` 盖掉 wm.js 内联值）：
- **窗口近全屏**：手机上一律铺满（菜单栏下 ~ Dock 上，`100dvh-102px`），一次专注一个 app（像 iOS）；隐藏手动缩放角
- **菜单栏精简**：隐藏桌面多级菜单（文件/编辑/显示…），留 Apple logo + 状态图标
- **触摸放大**：红绿灯 14px、标题栏 42px、操作按钮 34px 热区
- **Dock 横向可滚动**：图标 48px、隐藏 hover 气泡，防图标挤爆
- 桌面隐喻与"现场写应用"笑点完整保留。实测 iPhone(390px)：劝退页消失、启动台全屏网格、缓存应用全屏、菜单栏 0 个桌面菜单溢出。桌面端(>760px)零影响。

### 手机体验二期（2026-06-13）

- **生成感知视口**：前端 `/api/generate` 带 `vw=innerWidth`，≤760 时 user prompt 追加移动布局要求（单栏、触摸目标 ≥44px、侧栏改分段控件/抽屉；浏览器页出移动版排版）。活动日志 gen 事件带 `mob:1`。注意：搜索应用按名字缓存，手机生成的单栏版会被桌面复用（单栏在桌面窗口可用，接受）。
- **虚拟键盘补偿**：iOS Safari 键盘弹起不缩 layout viewport，应用内 fixed bottom 输入条被盖。main.js 用 `visualViewport` 维护 `--vvh` + `body.kb-open`（高度差 >100 判键盘），CSS 窄屏下窗口收进可视区、隐藏菜单栏/Dock，`scrollTo(0,0)` 拉回被顶起的页面。
- **PWA**：`web/manifest.webmanifest`（standalone）+ `icons/icon-{180,192,512}.png`（Pillow 生成，180 为 iOS 方形）+ apple-touch meta。加到主屏幕后全屏无地址栏。MIME 表补 `.webmanifest`。

## 内网运维控制台（2026-06-12 上线）

`admin/server.mjs` 独立进程（重启主服务不杀面板），零依赖，绑 `0.0.0.0:7101`——**不进 Cloudflare 隧道，公网不可见**，内网 `http://<源站内网IP>:7101` 访问（真实地址见 `deploy/INTERNAL.md`），凭 `.env` 的 `ADMIN_TOKEN`（缺失自动生成写回）。
- **看**：服务状态（improv/opencode/cloudflared/公网端到端）、系统资源、实时并发/排队/在线访客、承载与吞吐曲线（5s 采样 1h 环形）、**实时活动流**（SSE 直播：谁在生成什么/修改/能力调用/429/限流/访客）、四单元日志（journalctl 失败自动升 sudo -n）
- **控**：白名单启停（含「下线公网」=stop cloudflared）、`.env` 白名单参数在线调整（GEN_CONCURRENCY 等 7 键，越界拒绝）+ 一键保存重启
- **数据源**：主服务 `logActivity()` 落 `apps/activity.ndjson`（1MB 轮转），事件 visit/gen/done/modify/repair/cap_ai/cap_http/retry429/upstream_error/limited/blocked/busy；`/api/live` 加 visitors5m/todayGens/todayTokens
- systemd：`deploy/improv-admin.service`（system 级，User 为部署用户）。鉴权 query/cookie/Bearer 三态 + timingSafeEqual；query 进来即种 HttpOnly cookie 并 302 清地址栏。

## 计费系统重做（2026-06-14）

修复前 token 统计三大盲点:快轨只记输出(`anthropicCall` 只取 `output_tokens`)、图标/审核完全没计、能力 AI 只进日预算不进总量——线上 36.9M 实为约一半真实量。重做为**统一入账**:
- **`accrue(u)`** 集中累加,所有上游消耗都过它:`anthropicCall` 在 `r.on('end')` 解析 `message_start` 的 `input_tokens`/`cache_read`/`cache_creation` + `message_delta` 的 `output_tokens` 后 accrue(覆盖快轨续写修复 / 图标 / 审核 / 能力 AI);慢轨 opencode 在 `runAgent` 单独 accrue(不分缓存)。
- **分四类存**:`stats.{inTokens,outTokens,cacheReadTokens,cacheCreateTokens}`,从修复点起精确;`totalTokens` 改为全量(in+out+cache)继续累加(历史段偏小属正常)。
- **`bumpGens()`** 只在 `finishGeneration` 计生成次数,与 token 累加解耦(图标/审核不算"生成")。
- **节流写盘**:`markStatsDirty` + 防抖 2s flush + 进程退出(SIGTERM/SIGINT/exit)flush,避免高频同步写阻塞事件循环。
- **成本换算**:`.env` 配 `PRICE_{IN,OUT,CACHE_READ,CACHE_WRITE}_PER_M`(元/百万,留空不算),`estCost()` 保留完整精度、展示层舍入;`/api/stats` 暴露 `tokens`(四类)+ `cost`;运维面板加 4 个指标卡。
- `ICON_BACKFILL=0` 关开机图标补齐(测试隔离用)。e2e:`tests/billing.e2e.test.mjs`(mock 带 usage 上游,断言四类分项精确入账 + 成本换算)。

## 浏览量 + 点赞（2026-06-13）

- **浏览量**复用既有 `opens`（每次打开 +1，早已在索引），无新数据；只是把它和点赞做成可见的热度信号。
- **点赞**：`meta.likes` 字段（与 opens 对称，落盘 + 进索引）。`POST /api/like {slug, op:'like'|'unlike'}` → `likes±1`（clamp ≥0）写盘 + 同步内存索引（零扫盘），返回权威 likes。
- 接口进 `GUARDED`（公网跨站被同源守卫拒，内网免）+ `capLimit.like`（默认 60/min/IP，`CAP_LIKE_PER_MIN`）。匿名无法硬防刷，前端 `localStorage` 记 `liked:<slug>` 软防重复 + 高亮。
- **展示**：应用窗口操作栏爱心按钮（toggle、乐观更新、服务端权威值修正）；启动台卡片角标 `eye 浏览量 / heart 赞数`；启动台新增「最受欢迎」分类（有人点赞才出现，按 likes 降序）。
- e2e：`tests/like.e2e.test.mjs`（+1/索引即时反映、unlike clamp 不为负、404、公网跨站 403）。

## 应用索引（2026-06-13）

启动台/Spotlight"拉取应用很卡"定位：`listApps()` 每次请求全量同步扫盘（`readdirSync` + 每应用 2×`existsSync` + `readFileSync`，`1+3N` 次同步 FS 调用），单进程下阻塞事件循环、拖慢同期所有请求（含生成 SSE），随应用数线性恶化；且 `/api/apps`·`/api/search`·`/api/stats` 各扫一遍无缓存。
- **改为内存索引**（`appIndex` Map: slug→meta 含 icon 布尔）：启动 `buildAppIndex()` 全量扫一次，此后增量维护——`saveApp` 落盘即 `indexApp(slug)`、`queueIcon` 写出图标即置 `icon=true`、`/api/app/:slug` 的 opens 自增同步内存（不重读盘）。请求路径零扫盘。
- `listApps()` 改为返回 `[...appIndex.values()]`（新数组，元素为索引内 meta 引用——调用方只读/排序，勿改元素属性）。
- 未做：接口分页 + 前端虚拟滚动（应用上规模再说，#1 已治本）。

## 结构

- `web/` 前端壳（原生 TS/JS + CSS，不引框架）
- `server/` Bun/Node 单进程：静态托管 + SSE 生成代理 + 缓存 + 限流
  - `server/lib/` 能力桥 + agent 库（ssrf/store/ratelimit/opencode/agent-events/gate，零依赖可单测）
  - `server/verify-html.mjs` agent 用的 HTML 验证 CLI
- `apps/` 生成应用落盘缓存（gitignore）；`apps/_store/` 共享 KV；`apps/_agent/` 慢轨工作目录
- `deploy/` opencode.json + opencode.service
- `tests/` node:test 单测（30 个：6 lib + 集成测）
