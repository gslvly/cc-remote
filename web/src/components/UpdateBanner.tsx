import { Show } from 'solid-js'
import { dismissUpdate, stale } from '../update'

// 有新版本但输入框里还有内容时不自动刷新，在顶部提示；点 × 先忽略，下次回到前台再判断
export function UpdateBanner() {
  return (
    <Show when={stale()}>
      <div class="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-30 flex justify-center px-4">
        <div class="pointer-events-auto flex items-center gap-2 rounded-full border border-sky-800 bg-sky-950/95 py-1 pr-1 pl-4 text-sm shadow-lg">
          <span>有新版本</span>
          <button
            onClick={() => location.reload()}
            class="rounded-full bg-neutral-100 px-3 py-1 font-medium text-neutral-900"
          >
            刷新
          </button>
          <button onClick={dismissUpdate} aria-label="稍后" class="px-2 text-lg leading-none text-neutral-400">
            ×
          </button>
        </div>
      </div>
    </Show>
  )
}
