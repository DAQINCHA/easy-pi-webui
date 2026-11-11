# pi webui 下一阶段交接清单

写于 2026-11-11。**进度（2026-11-11）：阶段 A / B / C 已全部完成，只剩阶段 D（PWA）未开始。** 给接手的 AI：这是一份实现清单，不是设计讨论。按顺序做，每阶段独立可用、可回滚。

## 0. 先读这些

- 项目：`node-server/new-pi-webui`
- 技术栈：原生 Node（`node:http` / `fs` / `child_process`）+ 原生 HTML/CSS/JS。**零 npm 依赖、无构建步骤**。
- 运行：`cd node-server/new-pi-webui && npm start`（或双击 `启动 Pi WebUI.command`），默认端口 30142。工作目录不再由启动命令固定，按「`--workspace` > `PI_WORKSPACE` > 本机保存 > 页面首次选择」决定；本机配置在 `~/.config/new-pi-webui/settings.json`。
- 结构：
  - `server.js`：HTTP/SSE、会话桥管理、自动命名、归档、删除
  - `lib/pi-bridge.js`：`pi --mode rpc` 子进程、JSONL 分帧、事件回放、主动/被动退出标记
  - `lib/sessions.js`：会话文件索引（逐行扫描，不能改回只读固定字节数）、标题/名字
  - `public/js/app.js`：全部前端状态与渲染
  - `public/js/markdown.js`：无依赖 Markdown
- 必读约束：仓库根 `AGENTS.md`。不要引入框架、npm 包、构建工具。
- 该项目**允许且鼓励**用无头 Chrome 做验证（截图、量尺寸、点击、收集控制台报错）。

### 现状不变量（改动时不要破坏）

1. 每个会话一个 pi 子进程；`bridges` 以 `s:<sessionId>` 为 key；SSE 只连当前会话。
2. `agent_settled` 时工具卡片全部收起；最终答案消息结束时也会收起。
3. 主动 `dispose()` 的退出标记 `intentional`，前端不弹错误；意外退出才提示。
4. 会话归档存在 `data/archived.json`（已 gitignore），不改 pi 的会话文件。
5. 侧栏宽度存 `localStorage["piwebui.sidebarWidth"]`；主题存 `piwebui.theme`，默认 `system`。
6. 左侧消息导航条按“最近的线”命中，整条竖条可点，阈值 18px。
7. `lib/sessions.js` 扫描大图会话必须逐行读，不能回到“读前 96KB 就解析”的做法。
8. 所有测试用临时会话；不要删除或改名用户已有会话。测试完删掉临时会话。

---

## 阶段 A：网页内切换工作区

**状态：已完成（2026-11-11，含最近使用记录悬停删除）。** 下面是当时的实现说明，留作参考；接手的 AI 从阶段 B 开始。

### 目标

侧栏左下角的「工作目录」可点击，输入或选择路径后，不重启服务就能换到另一个目录；会话列表、 新建会话、自动命名、归档/删除校验都跟着切过去。

### 验收

- 点击工作目录 → 弹窗可输入绝对路径，带最近使用列表。
- 切换后：侧栏会话列表变成新目录的会话，发消息在新目录里执行。
- 旧目录会话文件不受影响；旧目录正在跑的会话留在后台跑（切回去还能看到结果）。
- 非法路径（不存在/不是目录/没权限）有明确报错，不改变当前工作区。
- 刷新页面仍在当前工作区（至少本次进程内），服务重启后回落到 `PI_WORKSPACE`。
- 归档/删除/打开会话只允许操作当前工作区内的文件。

### 服务端

1. 把 `server.js` 顶部的 `const WORKSPACE` 改为可变状态：
   - `const INITIAL_WORKSPACE = resolve(flags.workspace || process.env.PI_WORKSPACE || process.cwd())`
   - `let workspace = INITIAL_WORKSPACE`
   - 新增 `function currentWorkspace() { return workspace; }`
2. 所有用到 `WORKSPACE` 的地方改为 `workspace`：
   - `new PiBridge({ cwd: workspace })`
   - `generateTitle()` 的 `cwd`
   - `listSessions(workspace)`、`sessionsDir(workspace)`
   - `/api/bootstrap`、`/api/session/snapshot` 返回的 `workspace` / `sessionsDir`
3. 收紧会话文件校验：`isSessionFile(file)` 增加工作区维度：
   ```js
   export function isSessionFile(file, cwd) {
     if (!file.endsWith(".jsonl")) return false;
     const target = resolve(file);
     const root = sessionsDir(cwd);
     return target.startsWith(root + "/");
   }
   ```
   更新所有调用：打开、归档、删除。
4. 新接口：
   ```http
   POST /api/workspace  { "path": "/绝对/路径" }
   200 { workspace, sessionsDir, sessions: [...], piVersion }
   400 { error: "..." }
   ```
   - `resolve()`、`statSync` 判断 `isDirectory()`；
   - 支持 `~` 展开（`path.startsWith("~")` → `homedir()`）；
   - 成功后 `workspace = next; sessionCache.at = 0;`；
   - 不杀任何进程；不自动建会话（由前端决定）。
5. 注意：`isSessionFile` 变更后，旧的归档记录里其他工作区的文件将不能再操作；这是预期。

### 前端

1. 把 `#workspaceChip` 从 `<div>` 改成 `<button>`，标题“切换工作区”，保留文件夹图标和目录名。
2. 点击打开一个弹窗（复用 `openModal`）：
   - 当前路径（只读）
   - `<input class="field" id="workspacePath">`，默认填当前路径
   - “最近”列表：`localStorage["piwebui.workspaces"]`，最多 8 条，点击填入
   - 按钮：取消 / 切换
3. `switchWorkspace(path)`：
   - 若 `state.streaming`，先确认：“当前会话还在运行，切换后它会在后台继续。”
   - 关闭旧 SSE（`state.es.close()`）
   - `POST /api/workspace`
   - 成功后：重置 `state.key/file/messages/tools/liveToolIds/attachments/rail`，更新 `state.workspace`、`state.sessions`，更新 `emptySub`，记入最近列表，调用 `newSession()` 让用户能直接输入
   - 失败：toast 错误，不动当前状态
4. 切换期间禁用工作区按钮，避免并发请求。
5. `bootstrap` 返回的 `workspace` 仍然用来初始化；`applySnapshot` 也要更新目录显示。

### 边界

- 切换前正在跑的任务：不 abort，不 dispose；只是前端断开 SSE，后台继续。切回来时 `openSession` 会复用同一个 bridge。
- 同一工作区重复切换：直接关闭弹窗，不做事。
- 路径含空格/中文：正常处理，不要拼接命令字符串。
- 不要自动把工作区写进服务端配置；服务重启以 `PI_WORKSPACE` 为准。

### 验证

- 准备两个目录（例如 `Coding/` 和 `~/Documents/Scratch/`），各有一个会话。
- 切换后看侧栏、发一条 “pwd” 让 pi 执行，确认输出是新目录。
- 切回旧目录，确认旧会话和刚才后台跑的结果都在。
- 非法路径：`/no/such/dir`、`/etc/hosts`（文件）都报错。
- 归档/删除一个非当前工作区的文件路径（用 curl 伪造）应返回 400。

---

## 阶段 B：消息编辑 / 重新生成 / 从某处分支

**状态：已完成（2026-11-11，全量实现）。** fork 语义的实测结论写在 `server.js` 的 `/api/fork` 路由注释里；后续维护按实测行为，不要按猜测。下面是当时的实现说明，留作参考。

### 目标

给纯 vibe coding 一个“后悔键”：

- 编辑我发过的某条消息 → 从那条消息之前分叉，把原文放回输入框，改完再发。
- 重新生成最后一条回答 → 从最后一条用户消息之前分叉，用同样的文字重跑。
- 不想要分叉时，随时可以留在原会话继续。

### 先验证 pi 的 fork 语义（必做，不要跳过）

在一次性会话里做实验，确认以下事实并写进注释：

1. `get_fork_messages` 返回哪些消息（`{entryId, text}`），是否只含当前分支的用户消息。
2. `fork {entryId}` 后：
   - `get_state.sessionId` / `sessionFile` 是否变化（是新建会话文件，还是同文件内换叶子）？
   - `get_messages` 是否变成“该消息之前”的历史（即被 fork 的那条不在里面）？
   - 返回的 `text` 是否就是被移除的那条用户消息原文？
3. `cancelled: true` 的情况如何处理。
4. 带图片的用户消息 fork 后图片是否丢失（大概率只剩 text）。

把结论写在 `server.js` 的 fork 路由注释里。后续实现按实测行为，不要按猜测。

### 服务端

1. `snapshot()` 增加 `forkMessages`：
   ```js
   const forks = await command(bridge, { type: "get_fork_messages" });
   // data.messages: [{ entryId, text }]
   ```
   只返回 `{entryId, text}`，不要带图片/base64。
2. 新接口：
   ```http
   POST /api/fork   { key, entryId }
   200 { text, snapshot }
   400 { error }
   ```
   实现：
   - `bridge.send({ type: "fork", entryId })`
   - 若 `data.cancelled` → 400 `{ error: "fork cancelled" }`
   - 重新取一份 `snapshot(bridge)` 返回（key 可能变化）
   - `sessionCache.at = 0`（新会话文件可能出现）
3. 注意：fork 后如果 `sessionId` 变化，`bridges` 里的 key 需要迁移：
   - 重新 `get_state`，若新 id 与旧 key 不同，把 `bridges` 的 key 改为新 id（同一 bridge 实例，不要新建进程）。
   - 返回的 snapshot 用新 key。
4. `set_session_name` 等逻辑不受影响。

### 前端

1. 快照里保存 `state.forkMessages`。
2. 渲染用户消息时，给每条用户消息一个从 `forkMessages` 映射来的 `entryId`：
   - 优先按顺序一一对应（UI 只显示当前分支的用户消息，`get_fork_messages` 也是当前分支）；
   - 数量不一致时按 `text` 前缀匹配；匹配不到就隐藏编辑按钮。
   - 图片消息：只匹配 text，图片会丢；编辑/重生成按钮对“带图片的消息”禁用并提示。
3. 用户消息 hover 操作（现有“复制”旁边）：
   - 「编辑」：调用 `/api/fork` → 用返回的 `text` 填输入框、聚焦、**不自动发送**；snapshot 更新后 UI 切到新分支。
   - 最后一条用户消息额外有「重新生成」：fork 后立刻把 `text` 发出去（`/api/chat`），并保持当前模型/思考级别。
4. 最后一条 assistant 消息 hover：
   - 「重新生成」：找到它前面最近的一条用户消息 entryId，fork 后重发同样的文字。
5. 所有操作在 `state.streaming` 时禁用；fork 请求期间按钮显示忙碌/禁用，避免连点。
6. fork 成功后：
   - `applySnapshot(snapshot)`；
   - 如果 key 变了：`connectStream()` 重连；
   - 如果没变：不需要重连，但消息列表已刷新；
   - `renderRail()` 会自动更新（用户消息变了）。
7. 文案：
   - 确认不需要额外弹窗，点击即执行（编辑不发送，安全）。
   - “重新生成”会丢弃当前这条回答之后的内容（实际上 fork 已经切走），可以加一句 toast：“已从这条消息重新开始”。

### 边界

- fork 时正在跑：禁止（按钮 disabled）。
- fork 后立刻发消息：等 snapshot 应用完再发，避免旧 key。
- 分支/重生成会产生新会话文件（如果实测如此），侧栏会出现新条目；自动命名仍会生效。
- 不要用“删除最后一条消息再发”的方式实现重生成，会破坏树结构。
- 不要直接改 `.jsonl` 文件。

### 验证

- 两轮对话后，编辑第一条用户消息 → 确认历史只剩编辑点之前，输入框有原文，改完发送只走新分支。
- 重新生成最后一轮 → 确认没有多出一条重复的用户消息（是替换/分叉，不是追加）。
- 带图片的消息：按钮禁用且有提示。
- fork 后侧栏/标题/上下文圆环/导航条都正常。
- 连续快速点两次“重新生成”只执行一次。

---

## 阶段 C：本轮改动摘要 + 完成通知

**状态：已完成（2026-11-11）。** 摘要后来按用户给的两张截图改成「居中、默认收起的胶囊 + 点开逐文件清单」：只显示文件数与所在目录，**不显示增删行数、不显示命令数、不做撤销按钮**，没有记录到文件改动的轮次不显示胶囊（撤销与精确行数超出范围，需另行定边界）。SW 版通知的 `notificationclick` / `clients.matchAll` 聚焦留到阶段 D 的 `sw.js`；目前没注册 SW 时走普通 `new Notification` + `onclick` 聚焦。下面是当时的实现说明，留作参考。

### 目标

每轮结束在最后一条回答下面加一行“本轮改了什么”；长任务跑完且页面不在前台时弹系统通知。

### 摘要

1. 状态：
   ```js
   state.turnFiles = new Map();  // path -> toolName
   state.turnCommands = 0;
   ```
   `agent_start` 时重置。
2. 在 `tool_execution_start`：
   - `toolName === "edit" || "write"` 且有 `args.path` → `state.turnFiles.set(path, toolName)`
   - `toolName === "bash"` → `state.turnCommands += 1`
3. `agent_settled` 时（工具卡片收起之后）：
   - 若 `turnFiles.size || turnCommands`，在最后一条消息后插入 `.turn-summary`：
     - “本轮改动 3 个文件：`a.js`、`b.css`、`c.md`”（最多列 5 个，多的写“等 N 个”）
     - 有命令则追加“· 运行 4 条命令”
   - 摘要不写进 `state.messages`，刷新后消失（可接受）。
4. 样式：13px、次要色、左侧文件/终端小图标，外边距与消息一致；深浅主题都要能看。
5. 已知限制写进注释：`codemode` 内部间接调用的写文件可能统计不到；只统计 `edit`/`write` 的 `args.path`。
6. 重渲染（resync）时移除旧摘要再插入，避免重复。

### 通知

1. “更多”菜单加一项「完成时通知」，带勾选状态，存 `localStorage["piwebui.notify"]`（默认关）。
2. 开启时（必须是用户点击的手势里）：
   ```js
   const permission = await Notification.requestPermission();
   ```
   拒绝/不支持 → toast。
3. `agent_settled` 时，满足以下全部才通知：
   - 开关开启、权限 granted
   - `document.hidden || !document.hasFocus()`
   - 本轮不是被 abort
4. 优先用 Service Worker：
   ```js
   const reg = await navigator.serviceWorker.ready;
   reg.showNotification("pi 已完成", { body: title + " · 本轮结束", tag: "pi-" + state.key });
   ```
   没有 SW 时退回 `new Notification(...)`。
5. 点击通知聚焦窗口：
   - 页面内监听 `notificationclick`（SW 版在 `sw.js` 里）；
   - `clients.matchAll` 找同源窗口 → `focus()`；没有则 `openWindow("/")`。
6. 不要在每次 `agent_end` 都通知；只在 `agent_settled`，且不要对历史回放/重连补通知。

### 验证

- 让 pi 跑一个会写文件的请求，结束后摘要列出的文件与工具卡片一致。
- 纯聊天（无工具）不出现摘要。
- 开通知 → 切到别的标签页 → 跑一条长任务 → 完成后收到通知；点通知回到页面。
- 关闭通知开关后不再弹。
- 拒绝通知权限时有提示，不反复请求。

---

## 阶段 D：PWA

**状态：未开始，这是下一步。** 阶段 A / B / C 已完成，不需要重做。

### 目标

可“安装到桌面/手机主屏”，断网时至少能打开外壳；不缓存 API 和会话数据；更新不会卡在旧代码。

### 文件

- `public/manifest.webmanifest`
- `public/sw.js`
- `public/icons/icon-192.png`、`icon-512.png`（可选 maskable-512）
- 修改 `public/index.html`：manifest、apple-touch-icon、`apple-mobile-web-app-capable`、`mobile-web-app-capable`
- 修改 `public/js/app.js`：注册 SW

### Manifest

```json
{
  "name": "pi webui",
  "short_name": "pi",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}
```

图标从 `public/logo.svg` 生成（macOS 可试 `sips -s format png --resampleHeightWidth 512 512 logo.svg --out icon-512.png`；不行就用任何本地工具生成，不要把 SVG 直接当 512 PNG）。深色底、π 标识，留一点内边距。

### Service Worker 策略（重点：不要造成“改了代码看不到”）

- 缓存名带版本，例如 `pi-webui-v1`；`activate` 时删除旧版本。
- **导航和静态资源用 network-first，失败才回退缓存**：
  - `request.mode === "navigate"` → `fetch` 失败时返回缓存的 `/index.html`
  - `/styles.css`、`/js/*.js`、`/logo.svg`、`/icons/*` 同样 network-first
- **`/api/*` 一律不缓存**，直接 `fetch`。
- `install` 时预缓存外壳；`skipWaiting()` + `clientsClaim()`，避免更新要等所有标签页关闭。
- 不要在 SW 里缓存 SSE（`/api/events`）。

### 注册

```js
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
```
- 只注册一次；`file://` 不注册。
- 可选：“更多”菜单加「安装到桌面」，用 `beforeinstallprompt` 事件；`display-mode: standalone` 时隐藏。

### 通知联动

- `sw.js` 加 `notificationclick`：聚焦已有窗口或 `openWindow("/")`。
- 阶段 C 的通知优先走 `registration.showNotification`，SW 注册失败时回退。

### 边界

- PWA/Service Worker 只在安全上下文可用：`127.0.0.1` / `localhost` / HTTPS。局域网 HTTP 不行，文档里要写清楚。
- 不要缓存 `/api/session/snapshot` 这类数据。
- 不要用 SW 拦截并伪造 API 响应。
- 开发时如果发现改了前端不生效，先检查 SW 缓存；network-first 就是为避免这个问题。

### 验证

- 新浏览器配置打开 `http://127.0.0.1:30142`，DevTools Application → Manifest 可安装、无错误。
- 断网（CDP `Network.emulateNetworkConditions` offline）刷新，外壳能打开；聊天请求失败时有正常错误提示。
- 改一行 CSS 刷新，立刻生效（证明 network-first 正确）。
- 安装后独立窗口打开，主题/侧栏宽度/外观模式正常。
- SW 注册失败时页面功能不受影响。

---

## 实施顺序与里程碑

1. **A 工作区切换** — 已完成（2026-11-11）
2. **B 分支/编辑/重生成** — 已完成（2026-11-11，全量实现；fork 语义实测结论在 `server.js` 的 `/api/fork` 注释里）
3. **C 摘要 + 通知** — 已完成（2026-11-11；摘要最终改为居中胶囊 + 展开清单，只讲文件改动）
4. **D PWA** — **未开始，下一步**（最后做，避免 SW 缓存干扰前面阶段的调试）

每个阶段结束都要：

```bash
cd node-server/new-pi-webui
npm run check
```

并用无头 Chrome 按上面的验收项点一遍；控制台 0 报错；不要只看代码。

---

## 全局回归清单（每阶段结束都过一遍）

- [ ] 发消息 → 流式输出 → 工具卡片运行中展开、最终答案后收起
- [ ] 历史会话打开：工具卡片默认折叠
- [ ] 思考块折叠/展开
- [ ] 归档 → 已归档分组 → 取消归档 / 删除（删除当前会话会自动新开，且不弹“进程退出”）
- [ ] 自动命名：新会话第一条回答后拿到短标题
- [ ] 左侧导航条：悬停有预览、整条可点、点击跳转
- [ ] 侧栏拖宽、刷新保持、双击复位
- [ ] 外观三模式：深色/浅色/跟随系统，系统切换实时跟随
- [ ] 手机宽度：抽屉侧栏、输入框不重叠、无横向滚动
- [ ] SSE 断线重连后消息不重复、不丢
- [ ] 大图会话（历史里有 1.8MB base64 的）在侧栏仍有正确标题，不卡死

---

## 不要做的事

- 不引入 React/Vue/Vite/Tailwind/npm 依赖/构建步骤。
- 不做文件树、Git 面板、worktree、终端、模型供应商配置、i18n、登录鉴权——这些不在本轮范围。
- 不改 pi 的会话文件格式，不手写 `.jsonl`。
- 不删除或重命名用户已有会话；测试用临时会话，测完删掉。
- 不把测试脚本、demo、临时文件留在仓库里。
- 不为了“功能对齐 pi-web”扩大范围。

---

## 给新 AI 的开场提示词（可直接粘贴）

> 你在 `node-server/new-pi-webui` 里实现下一阶段功能。先读 `docs/handoff-next-features.md` 和仓库根 `AGENTS.md`，再读 `server.js`、`lib/pi-bridge.js`、`lib/sessions.js`、`public/js/app.js`。
>
> 阶段 A / B / C 已完成，不要重做；接下来只做阶段 D（PWA）。每个阶段完成后运行 `npm run check`，并用无头 Chrome 按验收项实际点一遍（截图、量尺寸、收控制台报错）。这是原生 JS + 零依赖项目，不要添加任何 npm 包或构建步骤。
>
> 阶段 B 必须先做文档里写的 fork 语义实验，按实测结果实现，不要凭猜测。
>
> 测试只用临时会话，不要动用户已有会话；测试完把临时会话删掉。每完成一个阶段，向我汇报：改了什么文件、验证了什么、遇到什么取舍。
