# TODO

对照 Claude Code 常用功能和同类项目（CloudCLI、claude-code-viewer、Happy、T3 Code）挑出来的，按值得做的程度排。
已做：`/` 命令面板、切模型 / effort、按会话存草稿、拦 `/clear`、回退（rewind）。

## 发图片 / 截图（终端里的 Ctrl+V 贴图）

手机上截图给 Claude 看报错、看 UI，比打字描述快。

- 前端：输入框旁加附件按钮（`<input type="file" accept="image/*">`），先用 canvas 缩到长边 1568px 左右、转 JPEG，再 base64
- 服务端：`SendMessageBody` 加 `images`，`Session.send` 的 content 改成 `[{ type: 'image', source: { type: 'base64', media_type, data } }, …, { type: 'text', text }]`；
  Hono 默认的 body 大小上限、API 单图 5MB 上限要留意
- 显示：`user_input` 事件里只带图片数量或缩略图，别把整张 base64 塞进缓冲；transcript 读出来的历史消息里也有 image block，要能认出来

## 看改动汇总（终端里的 /diff）

现在只能在工具卡片里一张张翻，没有「这一轮 / 还没提交的改了哪些」的总览。

- 服务端：`GET /api/sessions/:id/diff`，在会话 cwd 里跑 `git diff HEAD` 和 `git status --porcelain`（新文件），限定在 roots 内，输出截断
- 前端：一个弹层，按文件折叠，复用 `Diff.tsx`
- 不是 git 仓库时，退而汇总本会话 Edit / Write 工具卡片里的改动

## `!` 直接跑命令（终端里的 shell 模式）

看一眼 `git status`、跑一下测试，输出也让 Claude 看到。优先级低：直接让 Claude 跑效果差不多。

- 服务端在会话 cwd 里执行，限时、截断输出
- 输出照终端的格式包成 `<bash-input>` / `<bash-stdout>` / `<bash-stderr>` 作为下一条用户消息的上下文发给 Claude（`transcript.ts` 已能把这几种标签显示成灰色提示）
