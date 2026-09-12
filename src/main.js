import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { useReader, saveReader } from './stores/reader'
import './style.css'

const pinia = createPinia()
createApp(App).use(pinia).use(router).mount('#app')
useReader(pinia).$subscribe((_, state) => saveReader(state))
