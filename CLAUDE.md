# cc-remote

## 测试

- `bun run check`：类型检查 + 单测。新单测用 `server/testkit.ts`（假 transcript、假 query）。
- 端到端 `bun scripts/e2e/<名字>.ts`。起服务端、登录、测试目录、模拟终端、清理都在 `scripts/e2e/harness.ts`，新批次只写自己的步骤；临时探测也用它，别另起服务端、别在 /tmp 建目录（不在 roots 里）。
- 8686 是平时在用的服务端，别动。
- e2e 真调 Claude，能用单测覆盖的就不写 e2e。

## 调试

- 看会话内容用 `bun scripts/inspect.ts <id前缀> [--port 8687]`（transcript 与服务端缓冲逐条对照），不手写 jq。
- 看接口返回用 api-curl skill（`bun scripts/api.ts <路径>`，token 自动带），不手写 curl。
- 核对页面用 harness 的 `text()`、`events()`，少读截图；`bun run dev` 的页面开着时用 ai-bridge skill 读运行时状态。

## 工作方式

- 读代码用 codegraph 按需取，不整文件 cat。
- 改代码只用 Edit / Write，小锚点精确替换；不用 sed、python 改源码（LSP 收不到，诊断会过期）。
- 动手前先写几行方案定下来，不在思考里反复推演。
- 能合并的命令合并成一次调用。
- 文件最多500行，超过必须汇报，能拆尽量拆。