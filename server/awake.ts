// 防睡眠：托管会话在跑、等审批时拉起 caffeinate -i（不让空闲睡眠），停下后再留一会儿：推送要发出去，手机上看到推送可能马上回。
// 平时要不要睡由用户在系统设置里定（手机要随时连得上，就设成接电源时不睡）。拦不住合盖睡眠，见 REFERENCE.md

/** 会话都空闲后再留多久 */
const TAIL_MS = 2 * 60_000

/** -w：服务端没了（包括被 kill -9）它跟着退出，不会一直撑着。unref：服务端退出时不等它 */
function caffeinate() {
  const proc = Bun.spawn(['/usr/bin/caffeinate', '-i', '-w', String(process.pid)], { stdio: ['ignore', 'ignore', 'inherit'] })
  proc.unref()
  return proc
}

export class Awake {
  private proc?: { kill(): void }
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private tailMs = TAIL_MS,
    private spawn: () => { kill(): void } = caffeinate,
  ) {}

  get holding() {
    return this.proc !== undefined
  }

  set(busy: boolean) {
    if (busy) {
      clearTimeout(this.timer)
      this.timer = undefined
      this.proc ??= this.spawn()
    } else if (this.proc && !this.timer) {
      this.timer = setTimeout(() => this.release(), this.tailMs)
    }
  }

  release() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.proc?.kill()
    this.proc = undefined
  }
}
