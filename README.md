# cc-remote

> Control your local **Claude Code** from your phone. 手机端远程遥控本机 Claude Code 的轻量 Web UI。
>
> **English:** cc-remote is a mobile-first remote control for [Claude Code](https://code.claude.com).
> It runs on your Mac over Tailscale and lets you drive multiple real Claude Code sessions from a
> phone PWA: streaming chat, tool cards, permission approvals, `AskUserQuestion` answers, plan
> approvals, terminal-session watching, and push notifications when input is needed.
> **中文：** cc-remote 是一个手机优先的 Claude Code 遥控器。服务端跑在你的 Mac 上（经 Tailscale
> 连接），手机 PWA 里可以同时指挥多个真实的 Claude Code 会话：流式输出、工具卡片、权限审批、
> 问答、计划批准、终端会话旁观，以及需要介入时推送到手机。

关键词 / Keywords: `claude-code` `claude-code-remote` `remote-control` `mobile` `pwa` `ios`
`android` `tailscale` `agent-sdk` `coding-agent` `claude-code-web-ui` `手机` `远程控制` `编程智能体`

## 功能特性 / Features

- 📱 **手机优先的 PWA**：添加到主屏即是 App，聊天流 + 工具卡片，输出逐字蹦出，切走再回来断点续播
- 🗂️ **多会话并行**：顶部标签条切换会话，跨会话的待批准横幅提醒
- ✅ **审批原样回传**：权限请求（允许 / 本会话允许 / 拒绝）、`AskUserQuestion` 选项、计划批准、中断、权限模式切换（对应终端 `Esc` / `Shift+Tab`）
- 👀 **终端会话只读旁观**：电脑终端里正在跑的会话，手机上实时看进度；终端退出后可一键接管（`claude --resume <id>` 亦可）
- 📊 **状态栏**：模型、上下文用量、缓存命中率、5h / 7d 额度，与终端 statusline 同口径
- 🔔 **推送到手机**：待批准、一轮结束、额度被拒时经 Bark / ntfy 推送（含深链接）
- 🔒 **只走 Tailnet**：默认只监听 Tailscale 地址，token 登录（httpOnly cookie），等同远程 shell 的安全级别
- 🪶 **轻量**：Bun + Hono 服务端，Solid 前端（gzip 后约 40KB），不重做 Claude Code 的任何能力——只做渲染与转发

设计原则：**遥控器，不是另一个 Claude Code**——跑的是本机真实的 `claude`（Agent SDK 启动，
与终端相同的设置、skills、hooks、MCP），工具、权限规则、斜杠命令、模型选择都是它自己的。

## 快速开始 / Quick Start

### 环境要求 / Requirements

- macOS（服务端，暂只支持 macOS：Tailscale 取地址、防睡眠、常驻、终端旁观都有 macOS 专属实现）+ 已登录的 [Claude Code](https://code.claude.com)（`claude` CLI 能正常用）
- [Bun](https://bun.sh) ≥ 1.3
- [Tailscale](https://tailscale.com)（手机与 Mac 在同一 tailnet，服务端默认只监听 100.x 地址）
- 手机浏览器（iOS Safari / Android Chrome，用于安装 PWA；推送需 Bark 或 ntfy App）

### 安装与运行 / Install & Run

```bash
git clone https://github.com/gslvly/cc-remote.git
cd cc-remote
bun install
bun run build     # 构建前端
bun run start     # 启动服务端（默认端口 8686）
```

首次启动会自动生成配置并打印登录 token：

```bash
bun run dev       # 开发模式：服务端 --watch + vite（本机调试用）
bun run check     # 类型检查 + 单测（改代码前先跑通）
```

### 配置 / Configuration

配置文件 `~/.cc-remote/config.json`（首次启动自动生成，权限 600）：

```jsonc
{
  "token": "<登录 token，自动生成>",
  "host": "tailscale", // "tailscale" = 自动取本机 100.x 地址；只在本机用可写 "127.0.0.1"
  "port": 8686,
  "roots": ["~"], // 允许浏览、开会话的目录白名单
  "maxLive": 6, // 同时活着的 claude 子进程上限
  "idleMinutes": 30, // 空闲多久回收子进程（下次发消息自动 resume）
  "push": {
    "bark": { "key": "<Bark App 的 device key>" },
    "ntfy": { "topic": "<难猜的 topic 名>", "server": "https://ntfy.sh" }
  },
  "publicUrl": "http://100.x.y.z:8686" // 推送深链接前缀，默认取监听地址
}
```

Bark / ntfy 配一个即可，也可都配；不配就不推送。`server` 不写即用公共服务。

### 常驻 Mac / Keep It Running

```bash
bun scripts/launchd.ts install   # 装成 launchd 用户代理：登录自启、退出拉起
bun scripts/launchd.ts restart    # 改了服务端代码后重启
bun scripts/launchd.ts status     # 看运行状态
bun scripts/launchd.ts uninstall  # 卸载
```

说明：用**用户代理**而非系统守护进程，因为 Claude 登录态在用户钥匙串里；
Mac 睡着 tailnet 就连不上——需要随时连得上请设成接电源时不自动睡眠，
服务端只在会话运行 / 等审批时挂 `caffeinate` 防止睡着。日志见
`~/Library/Logs/cc-remote.log`。

### 手机端 / On Your Phone

1. 浏览器打开 `http://<Mac 的 100.x IP>:8686`，用 token 登录一次
2. 「添加到主屏」（iOS 用 Safari 分享菜单，Android 用 Chrome 菜单），得到全屏 PWA
3. 推送：Bark 填 key，ntfy 订阅你配的 topic；点推送里的链接直达对应会话

注意：iOS 主屏 PWA 与 Safari 不共享 cookie，添加到主屏后要在 PWA 里重新登录一次；
纯 `http://100.x` 访问时 Service Worker 不生效，靠 HTTP 缓存头 + 构建号比对保证拿到新版 UI。

## 使用说明 / Usage

- **首页**：额度（5h / 7d 剩余）+ 全部会话 + 最近目录 / 收藏 / 目录浏览
- **目录页**：开新会话，或打开该目录的历史会话（发消息即 resume 成托管会话）
- **会话页**：标签条切换（● 运行中 / ◐ 待批准 / ○ 空闲 / ▣ 终端中只读，`[+]` 新建）；
  assistant 文本展开逐字蹦出，thinking 折叠，Bash / 文件改动 / 搜索等收纳为工具卡片，
  Todo 进度走顶部进度条；底部弹层处理权限请求与提问，计划（ExitPlanMode）可批准并可选同时切 acceptEdits
- **终端会话**：只读旁观、按整条消息刷新；终端退出后出现「接管」按钮
- **状态栏**：`目录 · 模型 · effort` + 上下文 / 缓存 / 5h / 7d 四格，阈值变色，倒计时实时走；
  数据全部取自 Claude Code 自己上报（最近一次响应的 usage、rate_limit_event），不另发请求

手机开的会话不会出现在终端 `/resume` 列表（SDK 会话的入口标记使然），
终端里用 `claude --resume <会话 id>` 接着聊。

## 架构 / Architecture

```text
                    ┌─ 概览流 SSE（全部会话状态 + 额度，轻量常连）
手机 PWA ──tailnet──┤
                    └─ 内容流 SSE（只连当前看的会话，切走即断）

Mac: cc-remote server (Bun + Hono)
  ├─ 托管会话 ×N：Agent SDK query()，每会话一个 claude 子进程 + 输出缓冲
  ├─ 终端会话旁观：读 ~/.claude/sessions 登记表 + 监听 transcript 追加
  ├─ 读 ~/.claude/projects（历史会话、最近目录）
  └─ 推送（可选）：Bark / ntfy
```

关键决策：Agent SDK（结构化消息做卡片渲染、权限走 `canUseTool` 回调，不用 PTY）；
干活全在服务端、手机只看当前会话；蹦字增量在服务端 80ms 合批；事件编号 `epoch:seq`
支持断线续传与上滑分页；命令走 REST、推送走 SSE。

## 安全 / Security

- 默认只监听本机 Tailscale 地址（100.64.0.0/10 的 utun 网卡），**不要在公网服务器上反代**——这个页面等同远程 shell
- 登录 token 存 httpOnly + SameSite=Strict cookie；`curl` 可用 `Authorization: Bearer <token>`
- `~/.claude/sessions/` 下的 `.key` 文件是密钥：只读 `.json` 登记表，绝不读取或外传 `.key`
- 需要 HTTPS（如 iOS Web Push）：自有域名 A 记录指向 Mac 的 tailscale IP，Caddy 用 DNS-01 签证书

## 开发 / Development

```bash
bun run dev       # 服务端 --watch + 前端 vite
bun run check     # 类型检查 + 单测（新单测用 server/testkit.ts）
bun scripts/inspect.ts <会话id前缀>  # 对照 transcript 与服务端缓冲逐条看会话
```

技术栈：Bun + Hono + `@anthropic-ai/claude-agent-sdk`（服务端），
Solid + micromark + Tailwind（前端，打包 JS 约 40KB gzip）。

## 相关项目 / Related

- [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui)（MIT，已归档，形态最接近）
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)（AGPL，功能较杂）
- [wbopan/cui](https://github.com/wbopan/cui)（已归档）
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code)（含移动端 App）
