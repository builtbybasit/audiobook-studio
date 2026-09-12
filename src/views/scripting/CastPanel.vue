<script setup>
// Character list with rename / merge / delete. Shared by variants A and B.
import { ref } from 'vue'
import { useApp } from '../../stores/app'
const props = defineProps({ bookId: String, characters: Array, counts: Object, active: String, compact: Boolean })
const emit = defineEmits(['select'])
const app = useApp()
const editing = ref(null)
const draft = ref('')
const mergeFrom = ref(null)
function startEdit(c) { editing.value = c.name; draft.value = c.name }
function commit() { if (editing.value) app.renameCharacter(props.bookId, editing.value, draft.value); editing.value = null }
</script>

<template>
  <div class="space-y-1">
    <div v-for="c in characters" :key="c.name" class="group rounded-lg border px-2 py-1.5 text-sm transition-colors"
      :class="[active === c.name ? 'border-violet-400 bg-violet-50 dark:bg-violet-500/10' : 'border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800', c.isNew && 'border-dashed border-amber-400']">
      <div class="flex items-center gap-2">
        <span class="h-3 w-3 shrink-0 rounded-full" :style="{ background: c.color }"></span>
        <input v-if="editing === c.name" v-model="draft" class="input min-w-0 flex-1 py-0" autofocus @keydown.enter="commit" @keydown.esc="editing = null" @blur="commit" />
        <button v-else class="min-w-0 flex-1 truncate text-left" @click="emit('select', c.name)" @dblclick="startEdit(c)">
          {{ c.name }}
          <span v-if="c.isNew" class="ml-1 rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600">new</span>
        </button>
        <span class="font-mono text-xs text-zinc-400">{{ counts[c.name] ?? 0 }}</span>
      </div>
      <div v-if="!compact" class="mt-1 flex items-center gap-1 pl-5 text-[11px] text-zinc-500">
        <span v-if="c.aliases.length" class="truncate">aka {{ c.aliases.join(', ') }}</span>
        <span class="ml-auto flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100">
          <button class="hover:text-violet-500" @click="startEdit(c)">rename</button>
          <template v-if="c.name !== 'Narrator'">
            <button class="hover:text-violet-500" @click="mergeFrom = mergeFrom === c.name ? null : c.name">merge</button>
            <button class="hover:text-red-500" @click="app.deleteCharacter(bookId, c.name)">delete</button>
          </template>
        </span>
      </div>
      <div v-if="mergeFrom === c.name" class="mt-1 pl-5">
        <select class="input w-full py-0.5 text-xs" @change="app.mergeCharacter(bookId, c.name, $event.target.value); mergeFrom = null">
          <option value="" disabled selected>Merge “{{ c.name }}” into…</option>
          <option v-for="o in characters.filter(x => x.name !== c.name)" :key="o.name" :value="o.name">{{ o.name }}</option>
        </select>
      </div>
    </div>
  </div>
</template>
