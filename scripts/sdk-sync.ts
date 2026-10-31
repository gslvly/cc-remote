// 把 SDK 换成与本机 claude 配套的版本（claude 升级后跑，deploy.sh 每次部署也会跑）：
// 本机 claude --version → npm 上 claudeCodeVersion 相同的那版 SDK → bun add --exact → 再核对一遍是同一个文件。已经配套就不动
//   bun run sdk:sync
import { $ } from 'bun'
import { cliVersion, installedSdk, sha256File } from '../server/claudeBin'
import { expandHome, loadConfig } from '../server/config'
import { pruneOld } from '../server/prune'
import { fetchNpm } from '../server/sdk'

const PKG = '@anthropic-ai/claude-agent-sdk'

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const { config } = loadConfig()
const path = config.claude ? expandHome(config.claude) : Bun.which('claude')
if (!path) fail('PATH 里没有 claude，配置里也没写 claude')

/** 删旧版 claude 和 bun 缓存里的旧 SDK（见 server/prune.ts），删不掉不算失败 */
const prune = async (sdk: string) => {
  try {
    const said = await pruneOld(path, sdk, process.cwd())
    if (said) console.log(`✓ ${said}`)
  } catch (e) {
    console.warn(`! 旧版没删掉：${e}`)
  }
}

const sum = sha256File(path)
const before = installedSdk()
if (before.checksums.includes(sum)) {
  console.log(`✓ 已配套：SDK ${before.version} ↔ claude ${before.cli}（${path}）`)
  await prune(before.version)
  process.exit(0)
}

const cli = await cliVersion(path)
if (!cli) fail(`${path} --version 没给出版本号`)

// 不用 npm view：npm 11 的 @* 只给最新一版，全量范围里有没 claudeCodeVersion 的老版本时又只给版本号
const npm = await fetchNpm()
if (!npm) fail('查 npm 失败')
const hit = npm.releases.find((r) => r.cli === cli)
if (!hit) fail(`npm 上还没有配 claude ${cli} 的 SDK，服务端先用 SDK ${before.version} 自带的 ${before.cli}`)

await $`bun add ${`${PKG}@${hit.version}`} --exact`
const after = installedSdk()
if (!after.checksums.includes(sum)) fail(`装了 SDK ${after.version}，但它配套的 claude ${after.cli} 与本机 ${path} 不是同一个文件`)
const dir = Bun.semver.order(after.version, before.version) > 0 ? '升级' : '降级'
console.log(`✓ SDK ${dir} ${before.version} → ${after.version}（配 claude ${after.cli}）。跑 bun run check，再重启服务`)
await prune(after.version)
