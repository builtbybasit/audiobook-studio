import { createRouter, createWebHistory } from 'vue-router'
import LibraryView from './views/LibraryView.vue'
import ScriptingView from './views/ScriptingView.vue'
import NarrationView from './views/NarrationView.vue'
import ExportView from './views/ExportView.vue'
import QueueView from './views/QueueView.vue'
import BookView from './views/BookView.vue'
import CastView from './views/CastView.vue'
import SearchView from './views/SearchView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/library' },
    { path: '/library', component: LibraryView },
    { path: '/queue', component: QueueView },
    { path: '/book/:bookId', component: BookView },
    { path: '/book/:bookId/cast', component: CastView },
    { path: '/book/:bookId/search', component: SearchView },
    { path: '/book/:bookId/scripting', component: ScriptingView },
    { path: '/book/:bookId/narration', component: NarrationView },
    { path: '/book/:bookId/export', component: ExportView },
  ],
})
