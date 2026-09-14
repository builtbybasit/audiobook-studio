<script setup>
// Shared chapter selector: checkboxes + per-stage status. Chapters are grouped by volume when a
// novel spans several EPUBs; each volume header can collapse and select/deselect its chapters.
// Each row has a peek (raw text preview) and can be skipped (excluded from every stage).
// Keyboard: ↑↓ move, space ticks, ↵ opens, / focuses search.
import { computed, ref } from "vue";
import { useApp, isNarrated } from "../stores/app";
import StatusDot from "./StatusDot.vue";
import { UiCheckbox, UiSelect } from "../ui";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";

const props = defineProps({
  bookId: String,
  stage: String, // 'scripting' | 'narration' | 'export'
  modelValue: { type: Array, default: () => [] },
  openedId: Number,
  runLabel: { type: String, default: "Run" },
  selectable: { type: Function, default: () => true },
});
const emit = defineEmits(["update:modelValue", "open", "run"]);
const app = useApp();
const chapters = computed(() => app.chaptersOf(props.bookId));
const volumes = computed(() => app.volumesOf(props.bookId));
const grouped = computed(() =>
  volumes.value.map((v) => ({ ...v, chapters: chapters.value.filter((c) => c.volumeId === v.id) })),
);
const multi = computed(() => volumes.value.length > 1);
const collapsed = ref(new Set());
const q = ref("");
const search = ref(null);
const lastClicked = ref(null);
const canPick = (c) => props.selectable(c) && !c.excluded;
const matches = (c) =>
  !q.value || c.title.toLowerCase().includes(q.value.toLowerCase()) || String(c.id) === q.value;
const visible = computed(() =>
  grouped.value
    .map((v) => ({ ...v, chapters: v.chapters.filter(matches) }))
    .filter((v) => v.chapters.length),
);
function jump(id) {
  document
    .getElementById(`vol-${props.bookId}-${id}`)
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
  const s = new Set(collapsed.value);
  s.delete(id);
  collapsed.value = s;
}

function statusOf(c) {
  if (props.stage === "scripting") return c.scripting;
  if (props.stage === "narration") return c.narration;
  return isNarrated(c) ? (c.narration === "stale" ? "stale" : "done") : "none";
}
const isDone = (c) => ["done", "fallback", "stale"].includes(statusOf(c));
function progressOf(c) {
  return props.stage === "scripting" ? c.scriptingProgress : c.narrationProgress;
}
function toggle(id, e) {
  const set = new Set(props.modelValue);
  if (e?.shiftKey && lastClicked.value != null) {
    const ids = chapters.value.filter(canPick).map((c) => c.id);
    const a = ids.indexOf(lastClicked.value),
      b = ids.indexOf(id);
    const on = !set.has(id);
    for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) {
      if (on) set.add(x);
      else set.delete(x);
    }
  } else if (set.has(id)) set.delete(id);
  else set.add(id);
  lastClicked.value = id;
  emit("update:modelValue", [...set]);
}
function all() {
  emit(
    "update:modelValue",
    chapters.value.filter(canPick).map((c) => c.id),
  );
}
function none() {
  emit("update:modelValue", []);
}
function pending() {
  emit(
    "update:modelValue",
    chapters.value.filter((c) => canPick(c) && !isDone(c)).map((c) => c.id),
  );
}
function volState(v) {
  const ids = v.chapters.filter(canPick).map((c) => c.id);
  const n = ids.filter((id) => props.modelValue.includes(id)).length;
  return {
    all: ids.length > 0 && n === ids.length,
    some: n > 0 && n < ids.length,
    done: v.chapters.filter(isDone).length,
  };
}
function toggleVol(v) {
  const ids = v.chapters.filter(canPick).map((c) => c.id);
  const set = new Set(props.modelValue);
  if (volState(v).all) ids.forEach((id) => set.delete(id));
  else ids.forEach((id) => set.add(id));
  emit("update:modelValue", [...set]);
}
function toggleCollapse(id) {
  const s = new Set(collapsed.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  collapsed.value = s;
}
const counts = computed(() => {
  const out = { done: 0, failed: 0, running: 0, stale: 0, fallback: 0, excluded: 0 };
  for (const c of chapters.value) {
    if (c.excluded) {
      out.excluded++;
      continue;
    }
    const s = statusOf(c);
    if (s in out) out[s]++;
  }
  out.done += out.fallback + out.stale;
  return out;
});
// keyboard on the list: rows are focusable; arrows move, space ticks, enter opens
function onRowKey(e, c) {
  const rows = [...e.currentTarget.closest("[data-list]").querySelectorAll("[data-row]")];
  const i = rows.indexOf(e.currentTarget);
  if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    rows[i + 1]?.focus();
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    rows[i - 1]?.focus();
  } else if (e.key === " ") {
    e.preventDefault();
    if (canPick(c)) toggle(c.id, e);
  } else if (e.key === "Enter") {
    e.preventDefault();
    emit("open", c.id);
  }
}
function onListKey(e) {
  if (e.key === "/") {
    e.preventDefault();
    search.value?.focus();
  }
}
function skip(c, v) {
  app.setExcluded(props.bookId, c.id, v);
  if (v && props.modelValue.includes(c.id))
    emit(
      "update:modelValue",
      props.modelValue.filter((x) => x !== c.id),
    );
}
const peek = (c) => {
  const t = app.rawText(props.bookId, c.id);
  return t.length > 700 ? t.slice(0, 700) + "…" : t;
};
</script>

<template>
  <div class="card flex h-full flex-col" @keydown="onListKey">
    <div
      class="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800"
    >
      <div>
        <div class="label">
          Chapters<span v-if="multi" class="font-normal normal-case tracking-normal text-zinc-400">
            · {{ volumes.length }} volumes</span
          >
        </div>
        <div class="text-xs text-zinc-500">
          {{ counts.done }} done · {{ counts.failed }} failed<span v-if="counts.stale">
            · <span class="text-amber-600">{{ counts.stale }} stale</span></span
          ><span v-if="counts.excluded"> · {{ counts.excluded }} skipped</span> ·
          {{ modelValue.length }} selected
        </div>
      </div>
      <div class="flex gap-1">
        <button class="btn-ghost btn-xs" @click="all">All</button>
        <button class="btn-ghost btn-xs" @click="pending">Pending</button>
        <button class="btn-ghost btn-xs" @click="none">None</button>
      </div>
    </div>

    <div class="flex items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      <input
        ref="search"
        v-model="q"
        class="input min-w-0 flex-1 py-0.5 text-xs"
        placeholder="Find chapter… (title or #)"
      />
      <UiSelect
        v-if="multi"
        :model-value="undefined"
        :options="volumes.map((v) => ({ value: v.id, label: v.name.split('·')[0].trim() }))"
        placeholder="Jump to…"
        size="xs"
        class="w-24"
        @update:model-value="jump"
      />
    </div>

    <div class="min-h-0 flex-1 overflow-auto py-1" data-list>
      <div v-if="!visible.length" class="px-3 py-4 text-center text-xs text-zinc-500">
        No chapter matches “{{ q }}”.
      </div>
      <template v-for="v in visible" :key="v.id">
        <div
          v-if="multi"
          :id="`vol-${bookId}-${v.id}`"
          class="sticky top-0 z-10 flex items-center gap-2 border-y border-zinc-100 bg-zinc-50 px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900"
        >
          <UiCheckbox
            :model-value="volState(v).all ? true : volState(v).some ? 'indeterminate' : false"
            size="xs"
            @update:model-value="toggleVol(v)"
          />
          <button
            class="min-w-0 flex-1 truncate text-left font-semibold"
            @click="toggleCollapse(v.id)"
          >
            <span class="mr-1 text-zinc-400">{{ collapsed.has(v.id) ? "▸" : "▾" }}</span
            >{{ v.name }}
          </button>
          <span class="shrink-0 font-mono text-[10px] text-zinc-400" :title="v.file"
            >{{ volState(v).done }}/{{ v.chapters.length }}</span
          >
        </div>
        <template v-if="!collapsed.has(v.id)">
          <div
            v-for="c in v.chapters"
            :key="c.id"
            data-row
            tabindex="0"
            class="group flex items-center gap-2 px-3 py-1.5 text-sm outline-none focus-visible:bg-zinc-100 dark:focus-visible:bg-zinc-800"
            :class="[
              openedId === c.id
                ? 'bg-violet-50 dark:bg-violet-500/10'
                : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
              !canPick(c) && 'opacity-50',
            ]"
            @keydown="onRowKey($event, c)"
          >
            <UiCheckbox
              :model-value="modelValue.includes(c.id)"
              :disabled="!canPick(c)"
              @click="toggle(c.id, $event)"
            />
            <StatusDot :status="c.excluded ? 'none' : statusOf(c)" />
            <button
              class="min-w-0 flex-1 truncate text-left"
              :class="[
                openedId === c.id && 'font-semibold',
                c.excluded && 'line-through decoration-zinc-400',
              ]"
              tabindex="-1"
              @click="emit('open', c.id)"
            >
              <span class="mr-1.5 font-mono text-[11px] text-zinc-400">{{
                String(c.id).padStart(2, "0")
              }}</span
              >{{ c.title }}
            </button>
            <!-- peek -->
            <PopoverRoot>
              <PopoverTrigger
                class="rounded px-1 text-[11px] text-zinc-400 opacity-0 hover:text-violet-500 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                title="peek at the chapter text"
                tabindex="-1"
                >⌕</PopoverTrigger
              >
              <PopoverPortal>
                <PopoverContent
                  side="right"
                  :side-offset="8"
                  align="start"
                  class="ui-popup w-[min(420px,90vw)] p-3 text-xs"
                >
                  <div class="mb-1 flex items-baseline gap-2">
                    <b class="text-sm">{{ c.title }}</b
                    ><span class="text-zinc-400"
                      >~{{ c.words.toLocaleString() }} words ·
                      {{ Math.round((c.words * 5.6) / 1000) }}k chars</span
                    >
                  </div>
                  <p
                    class="max-h-48 overflow-auto whitespace-pre-line font-serif text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300"
                  >
                    {{ peek(c) }}
                  </p>
                  <div
                    class="mt-2 flex items-center gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800"
                  >
                    <span class="text-zinc-500">{{
                      c.excluded
                        ? "Skipped: left out of every stage and the audiobook."
                        : "Front matter, notes, or a duplicate? Skip it."
                    }}</span>
                    <button class="btn-ghost btn-xs ml-auto" @click="skip(c, !c.excluded)">
                      {{ c.excluded ? "Include again" : "Skip this chapter" }}
                    </button>
                  </div>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
            <span v-if="c.excluded" class="text-[11px] text-zinc-400">skipped</span>
            <span
              v-else-if="statusOf(c) === 'running'"
              class="w-9 text-right font-mono text-[11px] text-violet-500"
              >{{ Math.round(progressOf(c)) }}%</span
            >
            <span v-else-if="statusOf(c) === 'failed'" class="text-[11px] text-red-500"
              >failed</span
            >
            <span
              v-else-if="statusOf(c) === 'stale'"
              class="text-[11px] text-amber-600"
              title="edited after narration"
              >stale</span
            >
            <span
              v-else-if="statusOf(c) === 'fallback'"
              class="text-[11px] text-amber-600"
              title="a chunk didn't verify and was kept as narration"
              >fallback</span
            >
            <span
              v-else-if="stage === 'scripting' && c.scripting === 'done'"
              class="font-mono text-[11px] text-zinc-400"
              title="segments"
              >{{ app.segmentsOf(bookId, c.id).length }}</span
            >
            <span
              v-else-if="stage !== 'scripting' && c.duration"
              class="font-mono text-[11px] text-zinc-400"
              >{{ Math.floor(c.duration / 60) }}:{{
                String(Math.round(c.duration % 60)).padStart(2, "0")
              }}</span
            >
          </div>
        </template>
      </template>
    </div>

    <div class="border-t border-zinc-200 p-2 dark:border-zinc-800">
      <div class="mb-1 text-center text-[10px] text-zinc-400">
        shift-click selects a range · ⌕ peeks at the text
      </div>
      <button
        class="btn-primary w-full justify-center"
        :disabled="!modelValue.length"
        @click="emit('run', modelValue)"
      >
        {{ runLabel }} <span class="opacity-70">({{ modelValue.length }})</span>
      </button>
    </div>
  </div>
</template>
