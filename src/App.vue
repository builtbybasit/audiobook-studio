<script setup>
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApp } from './stores/app'
import JobIndicator from './components/JobIndicator.vue'
import { TooltipProvider } from 'reka-ui'

const app = useApp()
const route = useRoute()

watch(() => route.params.bookId, (id) => { if (id) app.currentBookId = id }, { immediate: true })
watch(() => app.dark, (d) => document.documentElement.classList.toggle('dark', d), { immediate: true })

const stages = [
  { key: 'library', label: 'Library', icon: '▤', to: () => '/library' },
  { key: 'scripting', label: 'Scripting', icon: '✎', to: (b) => `/book/${b}/scripting` },
  { key: 'narration', label: 'Narration', icon: '♪', to: (b) => `/book/${b}/narration` },
  { key: 'export', label: 'Export', icon: '⤓', to: (b) => `/book/${b}/export` },
]
const activeKey = computed(() => route.path.match(/^\/book\/[^/]+$/) ? 'overview' : route.path.split('/').pop())
const p = computed(() => app.currentBookId ? app.progress(app.currentBookId) : null)
</script>

<template>
  <TooltipProvider :delay-duration="300">
  <div class="flex h-screen">
    <aside class="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div class="flex items-center gap-2 px-4 py-4">
        <div class="grid h-8 w-8 place-items-center rounded-lg bg-violet-600 text-white">◍</div>
        <div class="leading-tight">
          <div class="font-semibold">Audiobook Studio</div>
          <div class="text-[10px] uppercase tracking-wider text-amber-500">prototype</div>
        </div>
      </div>

      <nav class="mt-2 flex flex-col gap-0.5 px-2">
        <template v-for="(s, i) in stages" :key="s.key">
          <RouterLink
            v-if="s.key === 'library' || app.currentBookId"
            :to="s.to(app.currentBookId)"
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            :class="activeKey === s.key && 'bg-violet-50 font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'">
            <span class="grid h-6 w-6 place-items-center rounded-md border text-xs"
              :class="activeKey === s.key ? 'border-violet-400' : 'border-zinc-300 dark:border-zinc-700'">{{ i + 1 }}</span>
            <span class="flex-1">{{ s.label }}</span>
            <span v-if="p && s.key === 'scripting'" class="text-[11px] text-zinc-400">{{ p.scripted }}/{{ p.total }}</span>
            <span v-if="p && s.key === 'narration'" class="text-[11px] text-zinc-400">{{ p.narrated }}/{{ p.total }}</span>
            <span v-if="p && s.key === 'export'" class="text-[11px] text-zinc-400">{{ p.exported }}</span>
          </RouterLink>
          <div v-else class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-zinc-400">
            <span class="grid h-6 w-6 place-items-center rounded-md border border-dashed border-zinc-300 text-xs dark:border-zinc-700">{{ i + 1 }}</span>
            {{ s.label }}
          </div>
        </template>
      </nav>

      <div class="mx-2 mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <RouterLink to="/queue" class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" :class="activeKey === 'queue' && 'bg-violet-50 font-semibold text-violet-700 dark:bg-violet-500/10 dark:text-violet-300'">
          <span class="grid h-6 w-6 place-items-center rounded-md border border-zinc-300 text-xs dark:border-zinc-700">≡</span>
          <span class="flex-1">Queue</span>
          <span v-if="app.activeJobs.length" class="flex items-center gap-1 text-[11px] text-emerald-500"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"></span>{{ app.activeJobs.length }}</span>
        </RouterLink>
      </div>

      <div v-if="app.book" class="mx-3 mt-5 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
        <div class="label mb-1">Open book</div>
        <RouterLink :to="`/book/${app.book.id}`" class="block font-medium leading-snug hover:text-violet-500" :class="activeKey === 'overview' && 'text-violet-600 dark:text-violet-300'">{{ app.book.title }}</RouterLink>
        <div class="text-zinc-500">{{ app.book.author }}</div>
        <div class="mt-2 flex gap-2">
          <RouterLink :to="`/book/${app.book.id}`" class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" :class="activeKey === 'overview' && 'border-violet-400'">Overview</RouterLink>
          <RouterLink :to="`/book/${app.book.id}/cast`" class="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800" :class="activeKey === 'cast' && 'border-violet-400'">Cast <span class="text-zinc-400">{{ app.charactersOf(app.book.id).length }}</span></RouterLink>
        </div>
      </div>

      <div class="mt-auto p-3">
        <button class="btn-ghost w-full justify-center" @click="app.dark = !app.dark">{{ app.dark ? '☀ Light' : '☾ Dark' }}</button>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div class="text-sm text-zinc-500">
          <span class="capitalize text-zinc-900 dark:text-zinc-100">{{ activeKey }}</span>
          <span v-if="app.book"> · {{ app.book.title }}</span>
        </div>
        <JobIndicator />
      </header>
      <main class="min-h-0 flex-1 overflow-auto">
        <RouterView />
      </main>
    </div>
  </div>
  </TooltipProvider>
</template>
