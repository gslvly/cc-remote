import { createEffect, createSignal, Show } from 'solid-js'
import { api } from '../api'
import { go, route } from '../router'

export function Login() {
  const [token, setToken] = createSignal('')
  const [error, setError] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const login = async (value: string) => {
    setBusy(true)
    setError('')
    try {
      await api('/login', { token: value })
      go.home()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: SubmitEvent) => {
    e.preventDefault()
    void login(token())
  }
  // 扫码进来的：先把 token 从地址栏和历史记录里抹掉，再直接登录。
  // 跟着路由走而不是只在挂上时看一次：已经停在登录页时再打开码里的地址，只变 hash，组件不重建
  createEffect(
    () => {
      const r = route()
      return r.page === 'login' ? r.token : ''
    },
    (fromQr) => {
      if (!fromQr) return
      // 写信号要等下一拍才读得到，这里直接把值传下去
      setToken(fromQr)
      go.login(true)
      void login(fromQr)
    },
  )

  return (
    <form
      onSubmit={submit}
      class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <h1 class="text-xl font-semibold">cc-remote</h1>
      <p class="text-sm text-neutral-400">token 在电脑上的 ~/.cc-remote/config.json 里；也可以在电脑上运行 bun run qr，用相机扫码登录</p>
      <input
        type="password"
        autocomplete="current-password"
        value={token()}
        onInput={(e) => setToken(e.currentTarget.value)}
        placeholder="token"
        class="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-base outline-none focus:border-neutral-500"
      />
      <Show when={error()}>
        <p class="text-sm text-red-400">{error()}</p>
      </Show>
      <button
        disabled={!token() || busy()}
        class="rounded-lg bg-neutral-100 py-2.5 font-medium text-neutral-900 disabled:opacity-40"
      >
        登录
      </button>
    </form>
  )
}
