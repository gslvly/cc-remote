import { createSignal, Show } from 'solid-js'
import { api } from '../api'
import { go } from '../router'

export function Login() {
  const [token, setToken] = createSignal('')
  const [error, setError] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const submit = async (e: SubmitEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/login', { token: token() })
      go.home()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <h1 class="text-xl font-semibold">cc-remote</h1>
      <p class="text-sm text-neutral-400">token 在 Mac 上的 ~/.cc-remote/config.json 里</p>
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
