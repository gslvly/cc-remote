import { createEffect, createMemo, createSignal, Errored, For, Loading, refresh, Show } from 'solid-js'
import type { SdkJob, SdkStatus } from '../../../shared/protocol'
import { api } from '../api'
import { errorText } from '../format'

/** a 比 b 新（x.y.z，只比数字） */
function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return (x![i] ?? 0) > (y![i] ?? 0)
  return false
}

const working = (job?: SdkJob) => job?.state === 'running' || job?.state === 'restarting'
/** 重启的空档连不上，最多等这么久；launchd 拉起太快会被限流 10 秒 */
const MAX_DOWN = 90_000

/**
 * 首页顶上的横幅（SdkNotice）和底部的一行（SdkLine）共用：npm 上有新的 SDK、或本机 claude 比配套的旧时，在手机上一起升级。
 * 升级在服务端后台跑，这里每 1.5 秒重取一次看进度
 */
export function useSdk() {
  let last: SdkStatus | undefined
  let downSince = 0
  const status = createMemo(async (): Promise<SdkStatus> => {
    let s: SdkStatus
    try {
      s = await api<SdkStatus>('/sdk')
    } catch (e) {
      // 重启中：先顶着上一次的，太久没回来再报错
      if (!last?.job || last.job.state !== 'restarting') throw e
      downSince ||= Date.now()
      if (Date.now() - downSince < MAX_DOWN) return last
      return { ...last, job: { ...last.job, state: 'failed', error: '服务端一分半没起来，到电脑上看看日志' } }
    }
    downSince = 0
    // 重启后的服务端没有这次升级的记录：换上了就算做完，结果接着显示
    const prev = last?.job
    if (!s.job && prev?.state === 'restarting' && s.running.version === prev.target.version) s = { ...s, job: { ...prev, state: 'done' } }
    return (last = s)
  })
  /** 正在发的请求：升级、现查 */
  const [posting, setPosting] = createSignal<'' | 'upgrade' | 'check'>('')
  /** 现查过了：没有新版时底部那行说一声 */
  const [checked, setChecked] = createSignal(false)
  const [error, setError] = createSignal('')

  createEffect(status, (s) => {
    if (!working(s.job)) return
    const t = setTimeout(() => refresh(status), 1500)
    return () => clearTimeout(t)
  })

  const send = (what: 'upgrade' | 'check', path: string, body?: object) => async () => {
    setPosting(what)
    setError('')
    try {
      await api(path, body)
      if (what === 'check') setChecked(true)
      refresh(status)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setPosting('')
    }
  }

  // 要做的事，从先到后：装好了等重启、SDK 有新版本、只有本机 claude 旧。short 是底部那行用的
  const todo = () => {
    const { running, installed, latest, local, restartable } = status()
    if (installed !== running.version) return { text: `SDK ${installed} 已装好，重启服务端后生效`, short: '', button: restartable ? '重启生效' : '' }
    if (latest && newer(latest.version, running.version)) {
      const also = local && local.version !== latest.cli && !(local.version && newer(local.version, latest.cli)) ? '，本机 claude 一起换' : ''
      return {
        text: `SDK 有新版本 ${running.version} → ${latest.version}（配 claude ${latest.cli}${also}）`,
        short: `有新版 ${latest.version}`,
        button: restartable ? '升级并重启' : '升级',
      }
    }
    if (latest && local && !local.matched && (!local.version || newer(latest.cli, local.version)))
      return { text: `本机 claude ${local.version ?? '?'} 比 SDK 配套的 ${latest.cli} 旧`, short: `本机 claude 可更新到 ${latest.cli}`, button: '更新本机 claude' }
  }

  /** 放顶上的横幅：升级中 / 做完有结果、装好了等重启、出错，或该升了（有大版本、落后满 7 天）。其余时候只有底部一行 */
  const loud = () => {
    const s = status()
    return !!s.job || s.installed !== s.running.version || !!error() || (s.urge && !!todo())
  }

  return {
    status,
    posting,
    checked,
    error,
    todo,
    loud,
    upgrade: send('upgrade', '/sdk/upgrade', {}),
    check: send('check', '/sdk?fresh'),
  }
}

type Sdk = ReturnType<typeof useSdk>

/** 首页顶上 */
export function SdkNotice(props: { sdk: Sdk }) {
  const { status, posting, error, todo, loud, upgrade } = props.sdk

  const inUse = () => {
    const { running, local } = status()
    if (local?.matched) return `本机 claude ${local.version}（与 SDK ${running.version} 是同一个文件）`
    return `SDK ${running.version} 自带的 claude ${running.cli}${local ? `；本机 ${local.version ?? '?'} 与它不是同一个文件` : '；PATH 里没有 claude'}`
  }

  return (
    <Errored fallback={() => null}>
      <Loading fallback={null}>
        <Show when={loud()}>
          <section class="mb-4 flex flex-col gap-1.5 rounded-xl border border-sky-800 bg-sky-950/40 px-3 py-2.5 text-sm">
            <Show
              when={!working(status().job)}
              fallback={<span class="text-sky-300">{status().job!.step}…</span>}
            >
              <Show
                when={todo()}
                fallback={
                  <Show when={status().job?.state === 'done'}>
                    <span class="text-emerald-400">已是最新：SDK {status().running.version}</span>
                  </Show>
                }
              >
                {(t) => (
                  <div class="flex items-center justify-between gap-3">
                    <span>{t().text}</span>
                    <Show when={t().button}>
                      <button
                        disabled={!!posting()}
                        onClick={upgrade}
                        class="shrink-0 rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-50"
                      >
                        {t().button}
                      </button>
                    </Show>
                  </div>
                )}
              </Show>
            </Show>
            <span class="text-xs break-all text-neutral-500">在用：{inUse()}</span>
            <Show when={!status().restartable && status().installed !== status().running.version}>
              <span class="text-xs text-neutral-500">服务端不是 launchd / systemd 拉起的，要到电脑上重启</span>
            </Show>
            <Show when={status().job?.state === 'failed' ? status().job!.error : error()}>
              {(msg) => <pre class="text-xs whitespace-pre-wrap text-red-400">{msg()}</pre>}
            </Show>
            <Show when={status().job?.state === 'done' && status().job!.notes}>
              {(notes) => <For each={notes()}>{(n) => <pre class="text-xs whitespace-pre-wrap text-amber-300">{n}</pre>}</For>}
            </Show>
          </section>
        </Show>
      </Loading>
    </Errored>
  )
}

/** 首页底部：在用的版本，有新版但不急时也放这，随时能升级、现查一次。顶上有横幅时不显示 */
export function SdkLine(props: { sdk: Sdk }) {
  const { status, posting, checked, todo, loud, upgrade, check } = props.sdk
  return (
    <Errored fallback={() => null}>
      <Loading fallback={null}>
        <Show when={!loud()}>
          <p class="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-neutral-500">
            <span>
              SDK {status().running.version}
              {todo()?.short ? ` · ${todo()!.short}` : checked() ? ' · 已是最新' : ''}
            </span>
            <Show when={todo()?.button}>
              {(b) => (
                <button disabled={!!posting()} onClick={upgrade} class="text-sky-400 disabled:opacity-50">
                  {b()}
                </button>
              )}
            </Show>
            <button disabled={!!posting()} onClick={check} class="disabled:opacity-50">
              {posting() === 'check' ? '检查中…' : '检查更新'}
            </button>
          </p>
        </Show>
      </Loading>
    </Errored>
  )
}
