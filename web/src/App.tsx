import { createMemo, Match, Switch } from 'solid-js'
import { UpdateBanner } from './components/UpdateBanner'
import { DirPage } from './pages/DirPage'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { SessionPage } from './pages/Session'
import { route } from './router'

export function App() {
  const r = createMemo(route)
  // keyed：换了目录 / 会话就整页重建，页面里的状态不带过去
  const dir = () => {
    const x = r()
    return x.page === 'dir' && x.path
  }
  const sessionId = () => {
    const x = r()
    return x.page === 'session' && x.id
  }

  return (
    <>
      <Switch fallback={<Home />}>
        <Match when={r().page === 'login'}>
          <Login />
        </Match>
        <Match when={dir()} keyed>
          {(path) => <DirPage path={path} />}
        </Match>
        <Match when={sessionId()} keyed>
          {(id) => <SessionPage id={id} />}
        </Match>
      </Switch>
      <UpdateBanner />
    </>
  )
}
