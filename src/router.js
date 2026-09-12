import { createRouter, createWebHistory } from 'vue-router'
import LibraryView from './views/LibraryView.vue'
import ScriptingView from './views/ScriptingView.vue'
import NarrationView from './views/NarrationView.vue'
import ExportView from './views/ExportView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', component: LibraryView },
    { path: '/book/:bookId/scripting', component: ScriptingView },
    { path: '/book/:bookId/narration', component: NarrationView },
    { path: '/book/:bookId/export', component: ExportView },
  ],
})
