/**
 * 终端还占着的会话的底栏，代替输入框：只读（两边同时写会分叉）。
 * 终端退出、或 /clear 换了新会话后，服务端推来的 info 不再带 terminal，输入框随之出现，发消息直接 resume
 */
export function TerminalBar() {
  return (
    <div class="border-t border-neutral-800 bg-neutral-950 px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <p class="py-1.5 text-sm text-neutral-400">▣ 终端里正在用这个会话，手机上只能看</p>
    </div>
  )
}
