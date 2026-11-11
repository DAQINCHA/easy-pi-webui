# Pi WebUI 两项改动执行任务书

> 本文是待执行方案，不代表已实现。只做 A 默认工作区跨电脑、B 终端启动器退出清理；不增加 UI 进程管理、退出按钮、模型网关或其他功能。

## 1. 项目与执行边界

目标在用户 iMac：`/Users/daqincha/Library/Mobile Documents/com~apple~CloudDocs/Coding/node-server/new-pi-webui`。跨电脑路径可能不同，先定位项目，不硬编码此路径。独立零 npm 依赖 Node 静态站＋API，`npm start` 为 `node server.js`，前端在 `public`，无需构建。Node ≥22.19，本机 pi 已安装认证；默认 `127.0.0.1:30142`，后端启动 `pi --mode rpc`。

修改前查看 `git status`、保留备份，尊重未提交改动，遇冲突不覆盖。不推送，不无故加依赖，不读取或修改真实认证、模型配置。建议范围：`server.js`、`lib/pi-bridge.js`、`public/js/app.js`、相关目录选择区域、`启动 Pi WebUI.command`、README 和测试；先核实实际结构。

## 2. 已知现状（修改前重查源码与行号）

- 工作区当前取 `--workspace > PI_WORKSPACE > process.cwd()`，启动不验目录；变量只在内存，`POST /api/workspace` 才验证存在、可访问。切换目录会新建会话；会话 cwd 为当前工作区，CLI 会话默认保存在 `~/.pi/agent/sessions` 的路径 slug 分类下。
- `piwebui.workspaces` 仅记录最近 8 个目录；`piwebui.last` 恢复当前工作区最后会话。前端 boot 先请求 `/api/bootstrap`，再恢复或新建会话。
- `.command` 第 8–12 行将工作区固定为脚本上两级 `Coding/`，后台启动 Node 后 wait，无 exec/nohup/disown/trap。
- `server.js:770–776` 仅处理 SIGINT/SIGTERM：遍历 pool dispose、关闭 HTTP、最长 3 秒退出；无 SIGHUP/exit 兜底。`lib/pi-bridge.js:138–155` dispose 关 stdin，2.5 秒后 SIGTERM，spawn 非 detached。`server.js:317–325` 自动标题另启 `pi --print`，25 秒 timeout，也须清理。
- SSE 断开不停止任务；无连接且非 streaming 的闲置 pi，15 分钟后由分钟定时器回收，Node 不自动退出。保持这些页面生命周期语义。

## 3. A：本机默认工作区

1. 配置放在每台电脑自己的非 iCloud 目录，例如 `~/.config/new-pi-webui/settings.json`。新增字段只含 `version`、`workspace`，保留已有未知字段；不动 `~/.pi` 真实设置与凭据。
2. 启动优先级严格为 `--workspace > PI_WORKSPACE > 本机保存 > 首次提示选择`。移除 `process.cwd()` 隐式兜底和 `.command` 固定 `Coding/`。显式参数/环境路径无效时明确报错，不静默换目录；保存路径失效或配置不可解析时明确提示，进入未选择态。
3. 未选择时允许 loopback 服务与目录输入页面运行，但禁止 spawn pi、模型请求、自动恢复/新会话；所有 session API（含恢复、消息等入口）统一拒绝并给出清晰错误。bootstrap 安全返回未选信号，前端先判状态。沿用现有目录输入方式，无需系统文件选择器或新依赖。
4. 后端统一绝对化、校验目录及访问权限，返回 canonical 绝对路径。用户明确选择并确认可信路径后才启用；不得声称选目录即实现 pi 全面沙箱或权限隔离，不重造 pi 信任系统。
5. 成功的页面主动切换沿用原能力并持久化新选择。CLI/环境覆盖仅当次生效，不自动覆写保存配置；覆盖启动后仍允许页面主动切换并保存，重启仍按上述优先级。localStorage 不是服务器启动默认来源，保留最近列表与按工作区恢复兼容。
6. 配置采用同目录临时文件＋原子替换，目录/文件权限安全（例如 0700/0600）；读写或权限错误要可见，不能伪称保存成功，也不能损坏旧配置。明确失败时工作区是否已切换的反馈，不记录配置正文到日志。

## 4. B：终端退出清理

- 前台 `npm start`/`node` 的 Ctrl+C、SIGTERM，以及直接发给 Node 的 SIGHUP，进入统一幂等 shutdown。
- `.command` 可后台启动 Node 以开浏览器，但必须 trap INT/TERM/HUP/EXIT，仅向自己记录的 `SERVER_PID` 准确转发并 wait 回收，防递归、重复清理和误杀；也可采用经验证的 exec＋受控浏览器 helper 等效方案。正常等待与异常退出均须覆盖。
- 后端先拒绝新任务，清会话回收定时器，关闭 SSE/HTTP，清理 pool 中全部 pi、标题进程及相关计时器，确认真实退出再完成。设置有界强制兜底，协调现有 2.5/3 秒竞态；必要时 TERM→KILL，仅处理尚存且确认归本应用的子进程。不得在 `process.on('exit')` 做异步清理。
- 禁止按端口杀进程、`pkill pi/node`；不碰用户独立 CLI、pi-web/v2/v3 或网关。不能因标签关闭、刷新而杀任务，保留断页继续与 15 分钟回收。
- SIGKILL/系统崩溃无法捕获；未设计并验证进程组时，不保证工具任意孙进程全部清理。若必须引入进程组，验证绝不误杀启动 shell，说明边界，不作超范围承诺。

## 5. 测试与交付

使用 fake pi stub，隔离 HOME、配置和会话根，并确保标题命令也命中 stub；禁止真实模型请求和真实 auth 读取。不得为测试关终端而关闭用户真实工作窗口。

| 验收项 | 必须证明 |
|---|---|
| 跨电脑 | 模拟两套 HOME/不同项目位置，选择互不污染；重启记忆正确 |
| 工作区状态 | 首次、失效配置绝不 spawn；显式优先级及无效报错；override 不暗改配置，主动切换会保存；cwd 正确 |
| 前端与保存 | 刷新、最近列表、会话恢复兼容；权限不足、原子写失败可见且旧配置完整 |
| 退出入口 | 前台 INT/TERM/HUP；脚本 INT/TERM/HUP、终端关闭等效 PTY 测试；记录父子 PID，确认退出及端口释放 |
| 清理边界 | 重复信号幂等；不配合退出的 stub 触发超时强杀；标题进程被回收；独立 pi 不受影响 |
| 页面生命周期 | SSE/标签断开不终止任务，闲置回收保持原语义 |

交付改动文件清单、实现摘要、测试命令与结果（未测项明确标注）、启动/停止说明及限制。以实际验证为准，不把建议当已实现；有阻塞就说明，不扩大范围。
