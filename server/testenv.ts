// bun test 预载（见 bunfig.toml）：测试用临时的 CLAUDE_CONFIG_DIR，不碰真的 ~/.claude。
// 所有测试文件共用一份模块缓存，不在这里设的话，先跑的测试载入 config.ts 时就把真目录定死了
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const root = mkdtempSync(join(tmpdir(), 'ccr-test-'))
process.env.CLAUDE_CONFIG_DIR = root
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
