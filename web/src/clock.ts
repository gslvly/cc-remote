// 每秒走一次的时钟，全局一份：状态栏的缓存、额度倒计时靠它实时走（终端 statusline 只在重新执行时刷新）
import { createSignal } from 'solid-js'

const [now, setNow] = createSignal(Date.now())
setInterval(() => setNow(Date.now()), 1000)

export { now }
