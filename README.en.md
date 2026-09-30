# cc-remote

[简体中文](README.md) | **English**

> A lightweight web UI to control your local Claude Code from your phone.

cc-remote is a mobile-first remote control for [Claude Code](https://code.claude.com). The server runs on
your computer (macOS / Linux / Windows); your phone reaches it over your LAN or any overlay network you
choose, and you drive multiple real Claude Code sessions from a phone PWA: streaming chat, tool cards,
permission approvals, `AskUserQuestion` answers, plan approvals, terminal-session watching, and push
notifications when input is needed.

Unlike the official Remote Control, it works with API keys and custom `ANTHROPIC_BASE_URL`, and the phone
never talks to Anthropic — only to your own computer.

> The web UI is currently in Chinese only.

Keywords: `claude-code` `claude-code-remote` `remote-control` `remote-control-alternative` `mobile` `pwa`
`ios` `android` `self-hosted` `agent-sdk` `coding-agent` `claude-code-web-ui`

## Features

- 📱 **Mobile-first PWA**: add it to your home screen from the browser and it becomes an app (full screen, its own icon, nothing to install). Chat stream + tool cards, token-by-token output, resumes where you left off after switching away
- 🗂️ **Parallel sessions**: switch sessions from the top tab bar; a banner flags pending approvals in other sessions
- ✅ **Approvals passed straight through**: permission requests (allow / allow for this session / deny), `AskUserQuestion` options, plan approval, interrupt, permission-mode switching (the terminal's `Esc` / `Shift+Tab`)
- 👀 **Read-only view of terminal sessions**: watch sessions running in your computer's terminal live; once the terminal exits or runs `/clear`, it becomes a history session you can keep chatting in from the phone (or `claude --resume <id>`)
- 📊 **Status bar**: model, context usage, cache hit rate, 5h / 7d quota — same numbers as the terminal statusline
- 🔔 **Push to phone**: via Bark / ntfy when approval is needed, a turn finishes, or quota is rejected (with deep links)
- 🔑 **Any auth**: whatever your terminal `claude` uses — subscription login, API key, `ANTHROPIC_BASE_URL` proxies / compatible endpoints, Bedrock and other cloud providers
- 🔒 **Phone never talks to Anthropic**: the phone only connects to your own computer (LAN or your overlay network) — no Claude app, no Claude login on the phone; token login (httpOnly cookie), with the security weight of a remote shell
- 🪶 **Lightweight**: Bun + Hono server, Solid frontend (~40KB gzipped); reimplements nothing from Claude Code — it only renders and relays

Design principle: **a remote control, not another Claude Code** — it runs the real local `claude` (launched
via the Agent SDK, with the same settings, skills, hooks and MCP as your terminal); tools, permission rules,
slash commands and model selection are all its own.

## vs. the Official Remote Control

Claude Code ships with [Remote Control](https://code.claude.com/docs/en/remote-control) (`claude remote-control`:
take over a local session from the Claude app or claude.ai/code). If it works for you, it's less setup. The
two cases below are where cc-remote fits better.

### When the official Remote Control isn't available

Per the [official docs](https://code.claude.com/docs/en/remote-control#requirements), Remote Control doesn't
work in the cases below. cc-remote runs your local `claude`, so if it works in your terminal, it works here:

| Case | Official Remote Control | cc-remote |
|---|---|---|
| API key instead of a claude.ai subscription login | ✗ | ✓ |
| `ANTHROPIC_BASE_URL` pointing at a proxy, LLM gateway or other compatible endpoint | ✗ | ✓ |
| Amazon Bedrock / Google Cloud / Microsoft Foundry | ✗ | ✓ |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK` is set | ✗ (unset them) | ✓ |
| No Claude app on the phone (e.g. unavailable in your App Store region) | claude.ai web only | Browser PWA, no app needed |

### When you care about IP exposure

The official Remote Control doesn't do NAT traversal — your machine only makes outbound HTTPS requests. But
every message is relayed through Anthropic's servers, the transcript is stored there, and **the phone
(Claude app / claude.ai) connects to Anthropic directly**. That adds another device and another egress IP to
your account: if the phone's proxy is off, drops briefly, or leaks while switching between Wi-Fi and
cellular, Anthropic sees the phone's real IP.

With cc-remote, traffic flows like this:

```text
phone ──LAN / overlay──> your computer (cc-remote) ──> local claude ──your computer's proxy──> Anthropic
```

- The phone only connects to your own computer — not to Anthropic, no Claude login, no proxy needed on the phone
- Only `claude` on your computer talks to Anthropic, through the one egress your computer uses, exactly like
  in your terminal (when running as a background service, put the proxy in the service config — see "Start at
  login")
- The cc-remote server makes no requests to Anthropic itself (quota, context etc. come from `claude`'s
  responses) and contacts no external service except the optional Bark / ntfy push; transcripts stay in your
  local `~/.claude`
- Overlay networks do NAT traversal: their coordination / relay servers see your devices' public IPs (the
  overlay provider sees them, not Anthropic). If that bothers you, stay on the LAN or self-host Headscale / WireGuard

This only reduces exposure; it's no guarantee against account risk controls. Follow Anthropic's terms of
service and supported-region policy.

## Quick Start

### Requirements

- A macOS, Linux or Windows computer to run the server, with [Claude Code](https://code.claude.com) logged in (`claude` works in your terminal; on Windows Claude Code also needs Git for Windows — see its install docs)
- [Bun](https://bun.sh) ≥ 1.3
- The phone can reach the computer: same LAN, or an overlay network of your choice (see "Network" below)
- A phone browser (iOS Safari / Android Chrome, to install the PWA; push needs the Bark or ntfy app)

### Install & Run

```bash
git clone https://github.com/gslvly/cc-remote.git
cd cc-remote
bun install
bun run build     # build the frontend
bun run start     # start the server (default port 8686)
```

The first start generates the config and prints the login token and this machine's addresses. For
long-term use, continue with "Recommended Server Setup".

### Configuration

Config file `~/.cc-remote/config.json` (generated on first start; mode 600 on macOS / Linux; on Windows it's under `%USERPROFILE%\.cc-remote\`):

```jsonc
{
  "token": "<login token, generated>",
  "host": "0.0.0.0", // all interfaces by default; an interface's IP to listen only there; "127.0.0.1" for local only
  "port": 8686,
  "roots": ["~"], // allowlist of directories to browse and open sessions in; absolute or ~-prefixed, "D:\\code" on Windows
  "maxLive": 6, // max concurrent claude child processes
  "idleMinutes": 30, // idle time before a child process is reclaimed (resumed automatically on the next message)
  "push": {
    "bark": { "key": "<device key from the Bark app>" },
    "ntfy": { "topic": "<hard-to-guess topic>", "server": "https://ntfy.sh" }
  },
  "publicUrl": "http://192.168.1.8:8686" // deep-link prefix for push; defaults to the first address in the startup log
}
```

Configure Bark, ntfy or both; with neither, no push is sent. Omit `server` to use the public service.

### Network: Let the Phone Reach the Computer

The server listens on all interfaces by default, and the startup log lists this machine's addresses. How the
phone gets there is up to you — cc-remote isn't tied to any networking tool:

- **Same LAN**: put the phone on your home Wi-Fi and open `http://192.168.x.x:8686` from the log. Nothing to install.
- **Away from home**: use an overlay network to put the phone and computer on the same virtual network, e.g.
  [Tailscale](https://tailscale.com), [ZeroTier](https://www.zerotier.com), or self-hosted
  [Headscale](https://github.com/juanfont/headscale) / WireGuard, then open the computer's address on that network.
- **Listen on one interface only**: set `host` to that interface's IP (e.g. the one your overlay network assigned);
  other interfaces can't reach it. With Tailscale you can also write `"tailscale"` to pick its 100.x address
  automatically and wait for it at boot.
- If a proxy app on the computer runs in TUN (enhanced) mode, route your overlay network's range directly;
  otherwise replies may be captured by the proxy and the phone can't connect.
- Allow the port (default 8686) through the firewall:
  - **Windows**: on first start the firewall asks whether bun may access the network — allow it. If you missed it, add bun under "Windows Security → Firewall & network protection → Allow an app through firewall".
  - **macOS**: if the firewall is on, allow bun to accept incoming connections when prompted.
  - **Linux**: with ufw, run `sudo ufw allow 8686/tcp`, or `sudo ufw allow in on <interface> to any port 8686` for one interface only.

### On Your Phone

1. Open an address from the startup log (`http://<computer IP>:8686`) in the browser and log in once with the token
2. **Add to Home Screen** (strongly recommended — it feels close to a native app):
   - **iOS**: open in Safari → "Share" button at the bottom → "Add to Home Screen" → "Add". Then open it from
     the home-screen icon and **log in with the token once more** (the home-screen app doesn't share cookies with Safari)
   - **Android**: open in Chrome → menu (top right) → "Add to Home screen" or "Install app"
3. Push: enter the key in Bark, or subscribe to your topic in ntfy; tapping a notification opens that session

Once it's on your home screen:

- Runs full screen with no address bar or bottom toolbar, so the chat gets more room; the dark status bar blends into the page
- One tap from the icon, and it's its own card in the app switcher — not mixed in with browser tabs, and not closed by accident
- Log in once and stay logged in; after you update the frontend on the computer, it switches to the new version when you come back (if there's unsent text in an input, it only shows a prompt instead of reloading)
- Switch away and come back: it reconnects automatically and resumes from where it left off

Notes:
- Android Chrome may only create a shortcut for a plain `http://<IP>` address, which still opens with an address
  bar. For full screen, serve it over HTTPS (see "Security"), or add `http://<computer IP>:8686` to
  *Insecure origins treated as secure* in `chrome://flags`, restart Chrome, then install.
- Over plain `http://<IP>` the Service Worker doesn't run; HTTP cache headers plus build-number checks keep the UI up to date.

### Updating

```bash
git pull && bun install && bun run build
```

Restart the service if the server changed (`server/`, `shared/`); for frontend-only changes, the phone
reloads by itself after the build, no restart needed.

## Recommended Server Setup

cc-remote only launches Claude Code, serves the page and sends push notifications. For a phone that can
always connect and open any project, set up the three items below. They differ per OS, so adapt them to
your machine:

| Setting | Without it |
|---|---|
| Start at login, restart on crash | After a reboot or crash, you have to go back to the computer and start it by hand |
| Disk access (macOS) | Projects under `~/Desktop`, `~/Documents` or external drives don't list, and Claude can't read or write files there |
| Keep the computer awake | Once the computer sleeps the network drops; the phone can't connect or wake it |

### 1. Start at Login, Restart on Crash

Run `bun run build` first. Keep in mind:

- Run it as **your own user**, not as a system service (root / LocalSystem): Claude's login and `~/.claude` belong to your user.
- Background services don't read `.zshrc` / `.bashrc`, so put proxy (`https_proxy` etc.) and `ANTHROPIC_*`
  variables in the service config. Forget the proxy and `claude` either can't connect or connects directly with your real IP.
- User services start only after you **log in once**: after a reboot, log in to the desktop first (with FileVault
  on, macOS asks for your password at boot anyway); on Linux, `loginctl enable-linger` lets it run without logging in.

Replace the paths below with your own (`which bun` / `Get-Command bun` shows where bun is).

**macOS (launchd user agent)**: create `~/Library/LaunchAgents/com.cc-remote.server.plist`

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
    <!-- if you need a proxy: <key>https_proxy</key><string>http://127.0.0.1:7890</string> -->
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/cc-remote.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/cc-remote.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cc-remote.server.plist  # load and start
launchctl kickstart -k gui/$(id -u)/com.cc-remote.server                            # restart
launchctl bootout gui/$(id -u)/com.cc-remote.server                                 # unload
tail -f ~/Library/Logs/cc-remote.log                                                 # view logs
```

After loading, macOS notifies you that a background item was added. Keep it enabled under "System Settings →
General → Login Items & Extensions → Allow in the Background", or it won't start at the next login.

**Linux (systemd user service)**: create `~/.config/systemd/user/cc-remote.service`

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
systemctl --user daemon-reload && systemctl --user enable --now cc-remote  # enable and start
loginctl enable-linger $USER             # keep running without a desktop login
systemctl --user restart cc-remote       # restart
journalctl --user -u cc-remote -f        # view logs
```

**Windows (Task Scheduler, start at logon)**: run in PowerShell from the cc-remote directory

```powershell
$action   = New-ScheduledTaskAction -Execute (Get-Command bun).Source -Argument 'server/index.ts' -WorkingDirectory (Get-Location).Path
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName cc-remote -Action $action -Trigger $trigger -Settings $settings
```

`Start-ScheduledTask cc-remote` starts it now, `Stop-ScheduledTask cc-remote` stops it, `Unregister-ScheduledTask cc-remote` removes it.
It opens a console window with the logs; closing the window stops the service. Set proxy variables as user
environment variables, then sign out and back in for them to take effect.

### 2. Disk Access (macOS)

macOS protects Desktop, Documents, Downloads, iCloud Drive, external and network volumes. A background
service can't show the permission prompt, so access is simply denied: those directories don't list, and
Claude fails to read or write files in them.

Grant bun Full Disk Access:

1. System Settings → Privacy & Security → Full Disk Access → click "+"
2. Press `Cmd+Shift+G` and enter bun's path (the one in the plist's `ProgramArguments`, e.g. `~/.bun/bin/bun`;
   for a Homebrew install, pick the real file the symlink points to), add it and turn it on
3. Restart the service: `launchctl kickstart -k gui/$(id -u)/com.cc-remote.server`

Notes:

- `claude` child processes are started by bun and inherit its permission; no need to add them separately
- When running `bun run start` in a terminal, the terminal app (Terminal, iTerm2, …) is what needs the permission — grant it there, or allow the prompt
- If directories stop listing after upgrading bun, remove bun from the list and add it again
- Full Disk Access is broad. If you'd rather not grant it, keep projects in an unprotected directory (e.g. `~/code`) and list only those in `roots`
- Linux and Windows have no such layer: the service runs as your user and can access what you can

### 3. Keep the Computer Awake

Once the computer sleeps the network drops; the phone can't connect or wake it. cc-remote doesn't manage
sleep — for the phone to connect anytime, set the computer to **not sleep automatically on power**
(turning off the display or locking the screen is fine):

| OS | Setting | Command |
|---|---|---|
| macOS | System Settings → Battery → Options (Energy on desktops) → turn on "Prevent automatic sleeping on power adapter when the display is off" | `sudo pmset -c sleep 0` |
| Linux | Turn off "Automatic suspend" in your desktop's power settings | `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` |
| Windows | Settings → System → Power → set sleep when plugged in to "Never" | `powercfg /change standby-timeout-ac 0` |

Laptops still sleep when the **lid is closed**:
- **macOS**: use an external display, or run `sudo pmset -a disablesleep 1` (set it back to 0 when done).
- **Linux**: set `HandleLidSwitchExternalPower=ignore` in `/etc/systemd/logind.conf`, then `sudo systemctl restart systemd-logind`.
- **Windows**: Control Panel → Power Options → Choose what closing the lid does → set "Plugged in" to "Do nothing".

On an always-on desktop you can also turn on **power on after power loss**; together with start-at-login,
the service comes back by itself after an outage: on macOS run `sudo pmset -a autorestart 1`; on Linux /
Windows enable "AC Power Recovery" / "Restore on AC Power Loss" in the BIOS.

## Usage

- **Home**: quota (5h / 7d remaining) + all sessions + recent directories / favorites / directory browser
- **Directory page**: start a new session, or open a history session from that directory (sending a message resumes it as a managed session)
- **Session page**: the tab bar switches between sessions open on the phone in the current directory (new or resumed; ● running / ◐ awaiting approval / ○ idle, `[+]` new).
  Terminal sessions and history sessions opened only for viewing stay out of the tab bar (reach them from Home or the directory page); history sessions are marked in the header, and sending a message resumes them and adds them to the tab bar.
  Assistant text streams in token by token, thinking is collapsed, Bash / file edits / searches are folded into tool cards,
  Todo progress shows as a top progress bar; bottom sheets handle permission requests and questions, and plans (ExitPlanMode) can be approved with an option to switch to acceptEdits at the same time
- **Terminal sessions**: read-only, refreshed per complete message; once the terminal exits or `/clear` starts a new session, the input box appears and sending a message resumes it
- **Status bar**: `directory · model · effort` + four cells for context / cache / 5h / 7d, colored by threshold, with live countdowns;
  all data comes from what Claude Code itself reports (the latest response's usage, rate_limit_event) — no extra requests

Sessions started from the phone don't appear in the terminal's `/resume` list (because of the SDK session's
entrypoint marker); use `claude --resume <session id>` in the terminal to continue them.

## Architecture

```text
                    ┌─ overview SSE (all session states + quota, light, always on)
phone PWA ─LAN/VPN──┤
                    └─ content SSE (only the session being viewed, dropped on switch)

computer: cc-remote server (Bun + Hono)
  ├─ managed sessions ×N: Agent SDK query(), one claude child process + output buffer per session
  ├─ terminal-session viewing: reads the ~/.claude/sessions registry + watches transcript appends
  ├─ reads ~/.claude/projects (history sessions, recent directories)
  └─ push (optional): Bark / ntfy
```

Key decisions: Agent SDK (structured messages render as cards, permissions via the `canUseTool` callback, no
PTY); all work happens on the server and the phone only watches the current session; streaming deltas are
batched every 80ms on the server; `epoch:seq` event IDs enable resume after disconnect and scroll-up paging;
commands go over REST, pushes over SSE.

## Security

- Listens on all interfaces by default, so devices on the same LAN / overlay network can open the login page;
  set `host` to one interface's IP to listen only there.
  **Don't expose it to the internet or reverse-proxy it on a public server** — this page is equivalent to a remote shell
- The login token is stored in an httpOnly + SameSite=Strict cookie; for `curl`, use `Authorization: Bearer <token>`
- The `.key` files under `~/.claude/sessions/` are secrets: only the `.json` registry is read; `.key` is never read or sent anywhere
- Need HTTPS (e.g. for iOS Web Push)? Point a domain's A record at the computer's LAN / overlay IP and have Caddy issue a certificate via DNS-01

## Development

```bash
bun run dev       # server --watch + frontend vite
bun run check     # type check + unit tests (new tests use server/testkit.ts)
bun scripts/inspect.ts <session id prefix>  # compare transcript and server buffer entry by entry
```

Stack: Bun + Hono + `@anthropic-ai/claude-agent-sdk` (server),
Solid + micromark + Tailwind (frontend, ~40KB of JS gzipped).

## Related

- [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui) (MIT, archived, closest in shape)
- [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) (AGPL, broader feature set)
- [wbopan/cui](https://github.com/wbopan/cui) (archived)
- [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (includes a mobile app)
