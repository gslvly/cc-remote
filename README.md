# cc-remote

**简体中文** | [English](README.en.md)

> 手机端远程遥控本机 Claude Code 的轻量 Web UI。

cc-remote 是一个手机优先的 [Claude Code](https://code.claude.com) 遥控器。服务端跑在你的电脑上
（macOS / Linux / Windows），手机经局域网或自选的组网工具连过来，在手机 PWA 里同时指挥多个真实的
Claude Code 会话：流式输出、工具卡片、权限审批、问答、计划批准、终端会话旁观，以及需要介入时推送到手机。

与官方 Remote Control 不同：API key、中转接口也能用，手机不连 Anthropic，只连你自己的电脑。

关键词：`claude-code` `claude-code-remote` `remote-control` `remote-control-alternative` `mobile` `pwa`
`ios` `android` `self-hosted` `agent-sdk` `coding-agent` `claude-code-web-ui` `手机` `远程控制` `编程智能体`

## 功能特性

- 📱 **手机优先的 PWA**：浏览器里添加到主屏幕即是 App（全屏、独立图标，不用装任何 App），聊天流 + 工具卡片，输出逐字蹦出，切走再回来断点续播
- 🗂️ **多会话并行**：顶部标签条切换会话，跨会话的待批准横幅提醒
- ✅ **审批原样回传**：权限请求（允许 / 本会话允许 / 拒绝）、`AskUserQuestion` 选项、计划批准、中断、权限模式切换（对应终端 `Esc` / `Shift+Tab`）
- 👀 **终端会话只读旁观**：电脑终端里正在跑的会话，手机上实时看进度；终端退出或 `/clear` 后它就是历史会话，手机上直接接着聊（`claude --resume <id>` 亦可）
- 📊 **状态栏**：模型、上下文用量、缓存命中率、5h / 7d 额度，与终端 statusline 同口径
- 🔔 **推送到手机**：待批准、一轮结束、额度被拒时推送（含深链接）：HTTPS 下 PWA 自己弹系统通知，也可经 Bark / ntfy
- 🔑 **不挑认证方式**：终端里的 `claude` 能用什么它就用什么——订阅登录、API key、`ANTHROPIC_BASE_URL` 中转 / 兼容接口、Bedrock 等云厂商通道
- 🔒 **手机不连 Anthropic**：手机只连你自己的电脑（局域网或自选组网），不装 Claude App、不登 Claude 账号；token 登录（httpOnly cookie），等同远程 shell 的安全级别
- 🪶 **轻量**：Bun + Hono 服务端，Solid 前端（gzip 后约 40KB），不重做 Claude Code 的任何能力——只做渲染与转发

设计原则：**遥控器，不是另一个 Claude Code**——跑的是本机真实的 `claude`（Agent SDK 启动，
与终端相同的设置、skills、hooks、MCP），工具、权限规则、斜杠命令、模型选择都是它自己的。

## 和官方 Remote Control 的区别

Claude Code 自带 [Remote Control](https://code.claude.com/docs/en/remote-control)（`claude remote-control`，
手机用 Claude App 或 claude.ai/code 接管本机会话）。能用它的话它更省事；下面两类情况更适合 cc-remote。

### 官方 Remote Control 用不了的

按[官方文档](https://code.claude.com/docs/en/remote-control#requirements)，下面这些情况 Remote Control 不可用。
cc-remote 跑的就是本机的 `claude`，终端里能正常用，它就能用：

| 情况 | 官方 Remote Control | cc-remote |
|---|---|---|
| 用 API key，而不是 claude.ai 订阅登录 | ✗ | ✓ |
| `ANTHROPIC_BASE_URL` 指向中转、LLM 网关或其他兼容接口 | ✗ | ✓ |
| Amazon Bedrock / Google Cloud / Microsoft Foundry | ✗ | ✓ |
| 设了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 或 `DISABLE_GROWTHBOOK` | ✗（要删掉这些变量） | ✓ |
| 手机上没有 Claude App（如国区 App Store） | 只能用 claude.ai 网页 | 浏览器 PWA，本来就不需要 |

### 在意 IP 暴露、担心风控的（如中国大陆用户）

官方 Remote Control 本机只发出站 HTTPS，并不打洞；但消息全经 Anthropic 服务器中转，会话记录也存在
Anthropic 服务器上，**手机端（Claude App / claude.ai）要直接连 Anthropic**。同一个账号就多了一台设备、
一个出口：手机代理没开、断了一下，或者 Wi-Fi 和蜂窝网络切换时漏了，Anthropic 看到的就是国内 IP。

cc-remote 的流量是这样走的：

```text
手机 ──局域网 / 组网──> 你的电脑（cc-remote）──> 本机 claude ──电脑上的代理──> Anthropic
```

- 手机只连你自己的电脑，不连 Anthropic，也不登录 Claude 账号，手机上不用开代理
- 跟 Anthropic 打交道的只有电脑上的 `claude`，出口就是电脑代理的那一个，和平时在终端里用完全一样
  （作为后台服务跑时，代理要写进服务配置，见「开机自启」）
- cc-remote 服务端自己不请求 Anthropic（额度、上下文等都取自 `claude` 的响应），除了可选的推送（Bark / ntfy，
  或开了系统通知的设备对应的浏览器推送服务）不连任何外部服务；会话记录只在本机 `~/.claude` 里
- 组网工具本身要打洞：它的协调 / 中继服务器能看到你设备的公网 IP（看到的是组网服务商，不是 Anthropic）。
  介意的话只在局域网用，或者自建 Headscale / WireGuard

这只是减少暴露面，不保证不被风控；请自行遵守 Anthropic 的服务条款与支持地区政策。

## 快速开始

### 环境要求

- macOS、Linux 或 Windows（跑服务端的电脑）+ 已登录的 [Claude Code](https://code.claude.com)（终端里 `claude` 能正常用；Windows 上 Claude Code 还需要 Git for Windows，见它的安装文档）
- [Bun](https://bun.sh) ≥ 1.3
- 手机能访问到电脑：同一局域网，或自选一个组网工具（见下文「网络」）
- 手机浏览器（iOS Safari / Android Chrome，用于安装 PWA；推送需 Bark 或 ntfy App）

### 安装与运行

```bash
git clone https://github.com/gslvly/cc-remote.git
cd cc-remote
bun install
bun run build     # 构建前端
bun run start     # 启动服务端（默认端口 8686）
```

首次启动会自动生成配置，并打印登录 token 和本机的访问地址。要长期用，接着看「推荐的服务端设置」。

### 配置

配置文件 `~/.cc-remote/config.json`（首次启动自动生成；macOS / Linux 上权限 600，Windows 上在用户目录 `%USERPROFILE%\.cc-remote\` 下）：

```jsonc
{
  "token": "<登录 token，自动生成>",
  "host": "0.0.0.0", // 默认监听所有网卡；写某个网卡的 IP 就只在它上面听，只在本机用写 "127.0.0.1"
  "port": 8686,
  "roots": ["~"], // 允许浏览、开会话的目录白名单；绝对路径或 ~ 开头，Windows 写 "D:\\code"
  "maxLive": 6, // 同时活着的 claude 子进程上限
  "idleMinutes": 30, // 空闲多久回收子进程（下次发消息自动 resume）
  "push": {
    "bark": { "key": "<Bark App 的 device key>" },
    "ntfy": { "topic": "<难猜的 topic 名>", "server": "https://ntfy.sh" }
  },
  "publicUrl": "http://192.168.1.8:8686" // 推送深链接前缀，默认取启动日志里列出的第一个地址
}
```

Bark / ntfy 配一个即可，也可都配；不配就不推送。`server` 不写即用公共服务。

### 网络：手机能连到电脑

服务端默认监听所有网卡，启动日志会列出本机的各个地址。手机怎么连过来由你选，cc-remote 不绑定任何组网方式：

- **同一局域网**：手机连家里的 Wi-Fi，打开日志里的 `http://192.168.x.x:8686`，什么都不用装。
- **出门在外**：用组网工具把手机和电脑拉进同一个虚拟网，比如 [Tailscale](https://tailscale.com)、
  [ZeroTier](https://www.zerotier.com)，或自建 [Headscale](https://github.com/juanfont/headscale) / WireGuard，
  手机打开电脑在虚拟网里的地址即可。
- **只在某个网卡上听**：`host` 写那个网卡的 IP（比如组网工具分的地址），别的网卡就访问不到。
  用 Tailscale 的话也可以写 `"tailscale"`，自动取它的 100.x 地址，开机时它没连上就等着。
- 电脑开着代理软件的 TUN（增强）模式时，要把组网工具的网段设为直连，否则回包可能被代理接管，手机连不上。
- 防火墙要放行端口（默认 8686）：
  - **Windows**：第一次启动时防火墙会弹窗问是否允许 bun 访问网络，选允许。错过了就去「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里加上 bun。
  - **macOS**：开了防火墙的话，弹窗时允许 bun 接受传入连接。
  - **Linux**：用了 ufw 的话执行 `sudo ufw allow 8686/tcp`，只放行某个网卡就 `sudo ufw allow in on <网卡名> to any port 8686`。

### 手机端

1. 浏览器打开启动日志里列出的地址（`http://<电脑 IP>:8686`），用 token 登录一次
2. **添加到主屏幕**（强烈推荐，用起来和原生 App 差不多）：
   - **iOS**：用 Safari 打开 → 底部「分享」按钮 → 「添加到主屏幕」→「添加」。之后从主屏图标打开，
     **在里面再用 token 登录一次**（主屏 App 与 Safari 不共享 cookie）
   - **Android**：用 Chrome 打开 → 右上角菜单 →「添加到主屏幕」或「安装应用」
3. 推送：Bark 填 key，ntfy 订阅你配的 topic；点推送里的链接直达对应会话
4. 系统通知（可选，要 HTTPS 访问，见「安全」；iOS 要 16.4+ 且从主屏图标打开）：首页标题旁点「开启通知」并允许，
   之后待批准、一轮结束由系统直接弹出，点开回到 PWA 的对应会话，不用另装 App。纯 `http://<IP>` 访问时没有这个开关，
   提醒照旧靠应用内的横幅和审批弹层

添加到主屏后：

- 全屏运行，没有地址栏和底部工具栏，聊天区域更大；深色状态栏和页面连成一体
- 主屏图标一点就开，多任务切换里是单独一张卡片，不和浏览器标签页混在一起，也不会被顺手关掉
- 登录一次长期有效；电脑上更新了前端，切回来时自动换成新版（输入框里有没发出去的内容时只提示，不强制刷新）
- 切走再回来接着看：断线自动重连，从断点续播

注意：
- Android Chrome 对纯 `http://<IP>` 地址可能只给快捷方式，打开后仍带地址栏。想要全屏，可以给服务配 HTTPS
  （见「安全」），或在 `chrome://flags` 的 *Insecure origins treated as secure* 里填上 `http://<电脑 IP>:8686`，
  重启 Chrome 后再安装。
- 纯 `http://<IP>` 访问时 Service Worker 不生效，靠 HTTP 缓存头 + 构建号比对保证拿到新版 UI。

### 更新

```bash
git pull && bun install && bun run build
```

改了服务端（`server/`、`shared/`）要重启服务；只改了前端，build 完手机页面会自己刷新，不用重启。

## 推荐的服务端设置

cc-remote 只负责拉起 Claude Code、提供页面和推送。想让手机随时能连、开什么项目都顺畅，建议把下面三项配上。
各系统做法不同，按自己的机器来：

| 设置 | 不配会怎样 |
|---|---|
| 开机自启、挂了拉起 | 电脑重启或进程崩了，得回到电脑前手动启动 |
| 磁盘访问权限（macOS） | `~/Desktop`、`~/Documents`、外接硬盘下的项目列不出来，Claude 也读写不了里面的文件 |
| 不让电脑睡着 | 电脑一睡网络就断，手机连不上，也叫不醒它 |

### 1. 开机自启、挂了拉起

先 `bun run build` 构建好前端。注意：

- 以**你自己的用户身份**跑，不要装成系统服务（root / LocalSystem）：Claude 的登录态和 `~/.claude` 都跟着用户走。
- 后台服务不读 `.zshrc` / `.bashrc`，代理（`https_proxy` 等）、`ANTHROPIC_*` 这类环境变量要写进服务配置里。
  漏了代理，`claude` 要么连不上，要么用本机 IP 直连。
- 用户服务要**登录一次**才会启动：电脑重启后先登录桌面（macOS 开了 FileVault 时开机本来就要输一次密码）；
  Linux 开了 `loginctl enable-linger` 可以不登录也跑。

下面示例里的路径都换成你自己的（`which bun` / `Get-Command bun` 查 bun 在哪）。

**macOS（launchd 用户代理）**：新建 `~/Library/LaunchAgents/com.cc-remote.server.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cc-remote.server</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/.bun/bin/bun</string><string>server/index.ts</string></array>
  <key>WorkingDirectory</key><string>/Users/you/cc-remote</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/you/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- 需要代理的话：<key>https_proxy</key><string>http://127.0.0.1:7890</string> -->
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/cc-remote.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/cc-remote.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cc-remote.server.plist  # 载入并启动
launchctl kickstart -k gui/$(id -u)/com.cc-remote.server                            # 重启
launchctl bootout gui/$(id -u)/com.cc-remote.server                                 # 卸载
tail -f ~/Library/Logs/cc-remote.log                                                 # 看日志
```

载入后系统会提示「已添加后台项目」。在「系统设置 → 通用 → 登录项与扩展」的「允许在后台」里保持它打开，
关掉的话下次开机就不会自启。

**Linux（systemd 用户服务）**：新建 `~/.config/systemd/user/cc-remote.service`

```ini
[Unit]
Description=cc-remote
After=network-online.target

[Service]
WorkingDirectory=%h/cc-remote
ExecStart=%h/.bun/bin/bun server/index.ts
Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
# Environment=https_proxy=http://127.0.0.1:7890
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now cc-remote  # 启用并启动
loginctl enable-linger $USER             # 没登录桌面也跑
systemctl --user restart cc-remote       # 重启
journalctl --user -u cc-remote -f        # 看日志
```

**Windows（任务计划程序，登录后启动）**：在 cc-remote 目录里用 PowerShell 执行

```powershell
$action   = New-ScheduledTaskAction -Execute (Get-Command bun).Source -Argument 'server/index.ts' -WorkingDirectory (Get-Location).Path
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName cc-remote -Action $action -Trigger $trigger -Settings $settings
```

`Start-ScheduledTask cc-remote` 立即启动，`Stop-ScheduledTask cc-remote` 停止，`Unregister-ScheduledTask cc-remote` 删除。
运行时会开一个命令行窗口，日志就在里面，关掉窗口服务就停了。代理这类变量设成用户环境变量，然后注销重新登录才会生效。

### 2. 磁盘访问权限（macOS）

macOS 会保护「桌面」「文稿」「下载」、iCloud 云盘、外接硬盘和网络硬盘等位置。后台服务弹不出授权窗口，
访问会被直接拒绝：目录页列不出来，Claude 读写这些目录下的文件也会失败。

推荐给 bun 开「完全磁盘访问权限」：

1. 系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 点「+」
2. 按 `Cmd+Shift+G`，输入 bun 的路径（就是 plist 里 `ProgramArguments` 写的那个，比如 `~/.bun/bin/bun`；
   Homebrew 装的要选它链接到的真实文件），添加后打开开关
3. 重启服务：`launchctl kickstart -k gui/$(id -u)/com.cc-remote.server`

说明：

- `claude` 子进程由 bun 拉起，跟着 bun 的授权走，不用单独加
- 在终端里 `bun run start` 前台跑时，看的是终端 App（终端、iTerm2 等）的授权，给它开，或者在弹窗里允许
- 升级 bun 后如果又列不出目录，在列表里把 bun 删掉重新加一次
- 完全磁盘访问权限范围很大。不想开的话，把项目放到不受保护的目录（比如 `~/code`），`roots` 也只写这些目录
- Linux、Windows 没有这层限制：服务以你的用户身份跑，你能访问的它就能访问

### 3. 不让电脑睡着

电脑睡着了网络也断了，手机连不上，也叫不醒它。cc-remote 不管睡眠，要手机随时能连，就把电脑设成**接电源时不自动睡眠**（关屏幕、锁屏不影响）：

| 系统 | 设置 | 命令 |
|---|---|---|
| macOS | 系统设置 → 电池 → 选项（台式机在「能源」里）→ 打开「显示器关闭时防止自动睡眠」 | `sudo pmset -c sleep 0` |
| Linux | 桌面的电源设置里关掉「自动挂起」 | `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` |
| Windows | 设置 → 系统 → 电源 → 接通电源时的睡眠设成「从不」 | `powercfg /change standby-timeout-ac 0` |

笔记本**合上盖子**还是会睡：
- **macOS**：要么接外接显示器，要么执行 `sudo pmset -a disablesleep 1`（不用了记得改回 0）。
- **Linux**：在 `/etc/systemd/logind.conf` 里设 `HandleLidSwitchExternalPower=ignore`，再执行 `sudo systemctl restart systemd-logind`。
- **Windows**：控制面板 → 电源选项 → 选择关闭笔记本计算机盖的功能 → 接通电源时设为「不采取任何操作」。

常开的台式机还可以打开**断电恢复后自动开机**，配合开机自启，停电回来服务自己就起来了：
macOS 执行 `sudo pmset -a autorestart 1`；Linux / Windows 在 BIOS 里打开「来电自启」（AC Power Recovery / Restore on AC Power Loss）。

## 使用说明

- **首页**：额度（5h / 7d 剩余）+ 全部会话 + 最近目录 / 收藏 / 目录浏览
- **目录页**：开新会话，或打开该目录的历史会话（发消息即 resume 成托管会话）
- **会话页**：标签条切换当前目录下手机上开着的会话（新建的、续接过的；● 运行中 / ◐ 待批准 / ○ 空闲，`[+]` 新建）。
  终端会话、只打开看的历史会话不进标签条（从首页、目录页进），历史会话页头标「历史」，发消息即续接并进标签条；
  assistant 文本展开逐字蹦出，thinking 折叠，Bash / 文件改动 / 搜索等收纳为工具卡片，
  Todo 进度走顶部进度条；底部弹层处理权限请求与提问，计划（ExitPlanMode）可批准并可选同时切 acceptEdits
- **输入框**：打 `/` 弹出命令和 skill 列表（Claude Code 自己给的，滤掉了手机上用不了的；`/context`、`/usage` 这类的输出照常显示）；
  `/clear` 不能发，开新会话用 `[+]`；没发出去的草稿按会话留着
- **切模型 / effort**：点页头的模型那段，只对本会话（同终端的 `/model`、`/effort`），子进程回收后续接也接着用
- **回退**（同终端里按两下 Esc）：空闲时点自己发的某条消息 →「回退到这里」，先预览要还原的文件，再选代码和对话都回退、只回退对话、只还原代码；
  回退了对话的，原文放回输入框。只还原 Claude 用 Write / Edit 改的文件（Bash 改的不算）；对话回不到第一条之前，代码可以
- **终端会话**：只读旁观、按整条消息刷新；终端退出或 `/clear` 换了新会话后，输入框直接出现，发消息即 resume
- **状态栏**：`目录 · 模型 · effort` + 上下文 / 缓存 / 5h / 7d 四格，阈值变色，倒计时实时走；
  数据全部取自 Claude Code 自己上报（最近一次响应的 usage、rate_limit_event），不另发请求

手机开的会话不会出现在终端 `/resume` 列表（SDK 会话的入口标记使然），
终端里用 `claude --resume <会话 id>` 接着聊。

## 架构

```text
                    ┌─ 概览流 SSE（全部会话状态 + 额度，轻量常连）
手机 PWA ──LAN/VPN──┤
                    └─ 内容流 SSE（只连当前看的会话，切走即断）

电脑: cc-remote server (Bun + Hono)
  ├─ 托管会话 ×N：Agent SDK query()，每会话一个 claude 子进程 + 输出缓冲
  ├─ 终端会话旁观：读 ~/.claude/sessions 登记表 + 监听 transcript 追加
  ├─ 读 ~/.claude/projects（历史会话、最近目录）
  └─ 推送（可选）：Bark / ntfy / 网页推送（Web Push）
```

关键决策：Agent SDK（结构化消息做卡片渲染、权限走 `canUseTool` 回调，不用 PTY）；
干活全在服务端、手机只看当前会话；蹦字增量在服务端 80ms 合批；事件编号 `epoch:seq`
支持断线续传与上滑分页；命令走 REST、推送走 SSE。

## 安全

- 默认监听所有网卡，同一局域网 / 组网里的设备都能打开登录页；只想在某个网卡上听就把 `host` 写成它的 IP。
  **不要暴露到公网，也不要在公网服务器上反代**——这个页面等同远程 shell
- 登录 token 存 httpOnly + SameSite=Strict cookie；`curl` 可用 `Authorization: Bearer <token>`
- `~/.claude/sessions/` 下的 `.key` 文件是密钥：只读 `.json` 登记表，绝不读取或外传 `.key`
- 需要 HTTPS（如 iOS Web Push）：自有域名 A 记录指向电脑的内网 / 组网 IP，Caddy 用 DNS-01 签证书

## 开发

```bash
bun run dev       # 服务端 --watch + 前端 vite
bun run check     # 类型检查 + 单测（新单测用 server/testkit.ts）
bun scripts/inspect.ts <会话id前缀>  # 对照 transcript 与服务端缓冲逐条看会话
```

技术栈：Bun + Hono + `@anthropic-ai/claude-agent-sdk`（服务端），
Solid + micromark + Tailwind（前端，打包 JS 约 40KB gzip）。

## 相关项目

- [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui)（MIT，已归档，形态最接近）
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)（AGPL，功能较杂）
- [wbopan/cui](https://github.com/wbopan/cui)（已归档）
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code)（含移动端 App）
