<script setup lang="ts">
// Asks what to do with the lines made before a speaker's voice or effect changed (`existingLines`
// store): redo all, from a chapter on, or picked chapters; or leave them. Mounted once in App.
import { computed, ref, watch } from "vue";
import { DialogTitle } from "reka-ui";

import { plural } from "@/lib/contents";
import { money } from "@/lib/pricing/format";
import { linesIn, useExistingLinesStore, type ExistingOption } from "@/stores/existingLines";
import { useLibraryStore } from "@/stores/library";
import { UiCheckbox, UiDialog, UiHint, UiSelect } from "@/ui";

const store = useExistingLinesStore();
const libraryStore = useLibraryStore();

const ask = computed(() => store.ask);
const open = computed({
  get: () => !!store.ask,
  set: (v) => {
    if (!v) store.ask = null;
  },
});
const voice = computed(() => ask.value?.kind === "voice");
const old = computed(() => (voice.value ? "voice" : "sound"));
const numberOf = (id: number) => libraryStore.chapterNumbers[ask.value?.bookId ?? ""]?.get(id);

const option = ref<ExistingOption>("none");
const from = ref<number | null>(null);
const picked = ref(new Set<number>());
watch(
  ask,
  (a) => {
    option.value = a?.start ?? "none";
    from.value = a?.chapters[0]?.id ?? null;
    picked.value = new Set();
  },
  { immediate: true },
);

const fromOptions = computed(() =>
  (ask.value?.chapters ?? []).map((c) => ({ value: c.id, label: String(numberOf(c.id) ?? "–") })),
);
function toggle(id: number) {
  const next = new Set(picked.value);
  if (!next.delete(id)) next.add(id);
  picked.value = next;
}

/** the chapters whose lines are redone, in reading order */
const chosen = computed<number[]>(() => {
  const all = ask.value?.chapters ?? [];
  if (option.value === "all") return all.map((c) => c.id);
  if (option.value === "from") {
    const at = all.findIndex((c) => c.id === from.value);
    return at < 0 ? [] : all.slice(at).map((c) => c.id);
  }
  if (option.value === "pick") return all.filter((c) => picked.value.has(c.id)).map((c) => c.id);
  return [];
});
const redo = computed(() => (ask.value ? linesIn(ask.value, chosen.value, !voice.value) : 0));
/** null when any chosen chapter is unpriced */
const cost = computed(() => {
  const ids = new Set(chosen.value);
  let sum = 0;
  for (const c of ask.value?.chapters ?? []) {
    if (!ids.has(c.id)) continue;
    if (c.cost == null) return null;
    sum += c.cost;
  }
  return sum;
});
const action = computed(() => {
  if (option.value === "none") return voice.value ? "Keep old voice" : "Keep old sound";
  if (!voice.value) return `Re-apply ${plural(redo.value, "line")}`;
  return (
    `Re-narrate ${plural(redo.value, "line")}` +
    (cost.value == null ? "" : ` · ~${money(cost.value)}`)
  );
});

const busy = ref(false);
async function act() {
  busy.value = true;
  await store.answer(chosen.value);
  busy.value = false;
}
</script>

<template>
  <UiDialog v-model:open="open" class="card w-[min(460px,94vw)] space-y-3 p-4">
    <template v-if="ask">
      <div>
        <DialogTitle class="font-semibold">{{ ask.title }}</DialogTitle>
        <p class="text-sm text-zinc-600 dark:text-zinc-300">
          {{ plural(ask.lines, "line") }} in {{ plural(ask.chapters.length, "chapter")
          }}{{ ask.names.length ? "" : " of this book" }} {{ ask.lines === 1 ? "has" : "have" }} the
          old {{ old }}.
        </p>
      </div>

      <p
        v-if="!ask.ready"
        class="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
      >
        Voice effects can’t run on this machine
        <UiHint
          label="why effects can’t run"
          text="The server runs them with uv, and can’t find it. Install uv and restart the server to re-apply; until then you can keep the old sound."
        />
      </p>

      <div class="space-y-1.5 text-sm" role="radiogroup" aria-label="Which chapters to redo">
        <template v-if="ask.ready">
          <label class="flex items-center gap-2">
            <input v-model="option" type="radio" value="all" class="accent-violet-600" />
            All chapters
          </label>
          <label class="flex items-center gap-2">
            <input v-model="option" type="radio" value="from" class="accent-violet-600" />
            From chapter
            <UiSelect
              :model-value="from"
              :options="fromOptions"
              size="xs"
              @update:model-value="
                (v) => {
                  from = v as number;
                  option = 'from';
                }
              "
            />
            on
          </label>
          <label class="flex items-center gap-2">
            <input v-model="option" type="radio" value="pick" class="accent-violet-600" />
            Pick chapters…
          </label>
          <div
            v-if="option === 'pick'"
            class="ml-6 grid max-h-40 grid-cols-4 gap-x-3 gap-y-1 overflow-y-auto text-xs sm:grid-cols-5"
          >
            <label
              v-for="c in ask.chapters"
              :key="c.id"
              class="flex items-center gap-1"
              :data-tip="plural(c.lines, 'line')"
            >
              <UiCheckbox
                size="xs"
                :model-value="picked.has(c.id)"
                @update:model-value="toggle(c.id)"
              />
              ch {{ numberOf(c.id) ?? "–" }}
              <span class="text-zinc-400">· {{ c.lines }}</span>
            </label>
          </div>
        </template>
        <label class="flex items-center gap-2">
          <input v-model="option" type="radio" value="none" class="accent-violet-600" />
          None: new lines only
          <UiHint
            label="leaving the lines as they are"
            :text="
              voice
                ? 'Lines already made keep the old voice; lines narrated from now on get the new one.'
                : 'Lines already made keep the old sound and stop counting as old. Chapters left out of a re-apply keep it too.'
            "
          />
        </label>
      </div>

      <p v-if="ask.unavailable" class="flex items-center gap-1 text-xs text-zinc-400">
        {{ plural(ask.unavailable, "line") }} can’t be re-applied — re-narrate them
        <UiHint
          label="lines that can’t be re-applied"
          text="They were made before effects were kept apart from the voice. Re-narrate them to change their sound."
        />
      </p>

      <div class="flex justify-end gap-2">
        <button v-if="!voice" class="btn-ghost btn-xs" @click="open = false">Later</button>
        <button
          class="btn-primary btn-xs"
          :disabled="busy || (option !== 'none' && !redo)"
          @click="act"
        >
          {{ action }}
        </button>
      </div>
    </template>
  </UiDialog>
</template>
