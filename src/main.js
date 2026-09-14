import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { useReader, saveReader } from './stores/reader'
import { useApp } from './stores/app'
import { keyring } from './lib/keyring'
import './style.css'

const pinia = createPinia()
createApp(App).use(pinia).use(router).mount('#app')
useReader(pinia).$subscribe((_, state) => saveReader(state))
keyring.set('openai', 'sk-prototype-demo-key-4f2a'); keyring.set('profile:openai', 'sk-prototype-demo-key-4f2a'); keyring.set('profile:deepseek', 'ds-prototype-91cd')   // PROTOTYPE: seeded key lives in the keyring, never in the store
useApp(pinia).demoKick()   // PROTOTYPE: start a few simulated jobs so the queue is alive on load
