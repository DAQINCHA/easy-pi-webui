# new-pi-webui

给 [pi](https://pi.dev) 做的一个网页界面。外观照着 CodeBuddy Code 的 web-ui 做（纯黑背景、细边框、会话侧栏、工具卡片），底层用 pi 自己的 RPC 模式跑真实的 pi 会话。

零 npm 依赖：服务端只用 Node 内置模块，前端是原生 HTML/CSS/JS，没有构建步骤。

## 启动

前提：Node.js 22.19 或更新，并且已经装好、登录过 pi（终端里 `pi --version` 有输出）。

```bash
cd node-server/new-pi-webui
PI_WORKSPACE="/要/让/pi/工作的/目录" npm start
```

然后打开 <http://127.0.0.1:30142>。

macOS 下也可以直接双击 `启动 Pi WebUI.command`，它会默认把工作目录设为这个仓库的根目录（也就是 `Coding/`）。

不设置 `PI_WORKSPACE` 时，工作目录就是启动命令所在的当前目录。

启动后也可以在左下角点击「工作目录」直接切换，无需重启；只对本次运行有效，重启后仍以 `PI_WORKSPACE` 为准。切换时可以在 Finder 里选目录，也可以直接输入路径；最近使用的 8 个目录记在浏览器本地。

## 能做什么

- 会话侧栏：按「今天 / 昨天 / 7 天内 / 更早」分组，能搜索、能开多个会话，切走的会话在后台继续跑
- 工作区切换：左下角目录卡片可直接在 Finder 中选择，或输入路径 / 点最近目录；记住最近 8 个，不重启服务就能换项目
- 自动命名：第一次对话结束后，让模型起一个短标题并存进会话（`PI_AUTO_TITLE=0` 可关闭）
- 会话归档：活动会话悬停点右侧的归档图标即可归档；归档的会话收进侧栏底部「已归档」分组，点「…」可以取消归档或删除会话
- 流式回复：文字边生成边显示，代码块有语法高亮和复制按钮
- 思考过程：折叠显示，可展开
- 工具调用：命令、文件读取、编辑差异（红绿 diff）、写入内容都以卡片展示，可折叠，带耗时和成功/失败状态
- 模型与思考深度切换、上下文占用百分比、token 与费用统计
- 斜杠命令：`/skill:xxx`、prompt 模板、扩展命令，输入 `/` 就有候选
- 图片：粘贴、拖入或点按钮添加，随消息一起发给 pi
- 压缩上下文、重命名会话、停止当前任务（Esc）
- 深色 / 浅色 / 跟随系统三种外观，窄屏自动变成抽屉式侧栏

## 它是怎么跑起来的

浏览器 ←SSE← Node 服务 ←JSONL/stdin+stdout→ `pi --mode rpc` 子进程

- 每个会话对应一个 pi 子进程，会话文件仍然写在 `~/.pi/agent/sessions/`，和命令行里的 pi 完全共用
- 服务端把 pi 的事件原样转发给浏览器，浏览器负责拼出流式消息和工具卡片
- 15 分钟无活动、没有连接、也不在跑任务的子进程会被回收

用的是 pi 官方文档里的 [RPC 模式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)，不是进程内 SDK——这样不用装 `@earendil-works/*` 依赖，也不会和已安装的 pi 版本打架。两者用的是同一套会话、模型和工具。

## 配置

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `PI_WORKSPACE` | pi 的工作目录（会话也按它分组） | 当前目录 |
| `PORT` / `PI_WEBUI_PORT` | 监听端口 | `30142` |
| `HOST` | 监听地址 | `127.0.0.1` |
| `PI_BIN` | pi 可执行文件路径 | `pi` |
| `PI_SESSION_DIR` | pi 会话根目录 | `~/.pi/agent/sessions` |
| `PI_AUTO_TITLE` | 设为 `0` 关闭首次对话后的自动命名 | 开启 |
| `PI_TITLE_MODEL` | 生成标题用的模型（对应 `pi --model`） | pi 默认模型 |

也可以用命令行参数：`node server.js --workspace /path --port 30142 --host 127.0.0.1`。

## 注意

- 默认只监听本机。改成 `0.0.0.0` 等于把「能执行命令的 agent」暴露到局域网，而且这个界面没有登录功能。
- 侧栏只列当前工作目录的会话；用左下角的目录按钮切换，切走的目录里正在跑的会话会留在后台。
- 还没做：项目文件浏览、上传文件、Git 面板、导出 HTML。

## 目录

```
new-pi-webui/
├── server.js            HTTP + SSE 服务
├── lib/
│   ├── pi-bridge.js     pi 子进程、JSONL 分帧、事件回放
│   ├── sessions.js      会话文件索引与标题提取
│   └── static.js        静态文件服务
├── public/
│   ├── index.html
│   ├── styles.css       CodeBuddy 风格的设计变量与组件
│   └── js/
│       ├── app.js       会话、流式渲染、菜单、弹窗
│       └── markdown.js  无依赖 Markdown 渲染 + 轻量高亮
└── 启动 Pi WebUI.command
```
