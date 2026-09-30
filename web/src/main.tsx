import { render } from '@solidjs/web'
import { App } from './App'
import './index.css'
import { initUpdate } from './update'

initUpdate()

render(() => <App />, document.getElementById('root')!)
