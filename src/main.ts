import './style.css'
import { MathTrainingApp } from './app'

const root = document.querySelector<HTMLElement>('#app')

if (!root) throw new Error('Mental Math Sprint could not find its app container.')

const app = new MathTrainingApp(root)
app.start()
