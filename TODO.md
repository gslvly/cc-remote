# TODO

对照 Claude Code 常用功能和同类项目（CloudCLI、claude-code-viewer、Happy、T3 Code）挑出来的，按值得做的程度排。
已做：`/` 命令面板、切模型 / effort、按会话存草稿、拦 `/clear`、回退（rewind）、发图片 / 截图、`!` 跑命令。

## 看改动汇总（终端里的 /diff）

现在只能在工具卡片里一张张翻，没有「这一轮 / 还没提交的改了哪些」的总览。

- 服务端：`GET /api/sessions/:id/diff`，在会话 cwd 里跑 `git diff HEAD` 和 `git status --porcelain`（新文件），限定在 roots 内，输出截断
- 前端：一个弹层，按文件折叠，复用 `Diff.tsx`
- 不是 git 仓库时，退而汇总本会话 Edit / Write 工具卡片里的改动
