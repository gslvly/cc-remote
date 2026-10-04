import { render } from '@solidjs/web'
import { App } from './App'
import './index.css'
import { initPush } from './notify'
import { initUpdate } from './update'

initUpdate()
void initPush()

render(() => <App />, document.getElementById('root')!)
