<script setup lang="ts">
// Fill speakers' blank age, gender and voice type from the book's fan wiki: pick who, read their
// pages one by one, review, apply. Pages are written from the whole series, so links stay hidden.
import { computed, ref, watch } from "vue";
import { DialogDescription, DialogTitle } from "reka-ui";

import { useCastStore, type WikiScope } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { plural } from "@/lib/contents";
import { UiDialog, UiHint } from "@/ui";
import SpoilerText from "@/components/SpoilerText.vue";
import { fillChips, webAddress } from "@/views/cast/wiki";
import type { SpeakerWikiFill } from "@/types";

const props = defineProps<{
  bookId: string;
  selected: ReadonlySet<string>;
  /** the scope it opens on */
  start?: WikiScope;
}>();
const open = defineModel<boolean>("open", { default: false });

const castStore = useCastStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();

const wiki = ref("");
const badWiki = computed(() => !!wiki.value.trim() && !webAddress(wiki.value));
// the server looks pages up on the saved address, so a run waits for the save
let saving: Promise<void> | undefined;
function saveWiki() {
  if (!badWiki.value) saving = libraryStore.setWiki(props.bookId, wiki.value);
}

const scope = ref<WikiScope>("main");
const scopes = computed(() =>
  (
    [
      ["main", "Main cast"],
      ...(props.selected.size ? [["selected", "Selected speakers"]] : []),
      ["many", "Every speaker with many lines"],
    ] as [WikiScope, string][]
  ).map(([value, label]) => ({
    value,
    label,
    ...castStore.wikiScope(props.bookId, value, props.selected),
  })),
);
const picked = computed(() => scopes.value.find((s) => s.value === scope.value));
const names = computed(() => picked.value?.names ?? []);
const profile = computed(() => scriptingStore.runProfile);
const why = computed(
  () =>
    castStore.aiBlocker ??
    (!wiki.value.trim()
      ? "Enter the book’s wiki address first"
      : !names.value.length
        ? "No speakers to look up in this choice"
        : undefined),
);

type Phase = "setup" | "running" | "review";
const phase = ref<Phase>("setup");
const rows = ref<SpeakerWikiFill[]>([]);
const ticked = ref(new Set<string>());
const asked = ref(0);
let stop: AbortController | null = null;
const halt = () => stop?.abort();

watch(open, (on) => {
  if (!on) return halt();
  wiki.value = libraryStore.bookById(props.bookId)?.wiki ?? "";
  scope.value = props.start ?? "main";
  phase.value = "setup";
  rows.value = [];
  ticked.value = new Set();
});

const byName = computed(() => castStore.byName[props.bookId]);
/** each answer with what it would fill, worked out once per answer, not per render */
const review = computed(() =>
  rows.value.map((row) => {
    const c = byName.value?.get(row.name);
    return { row, chips: c ? fillChips(c, row.fill) : [] };
  }),
);
const toApply = computed(() =>
  review.value.filter((r) => r.chips.length && ticked.value.has(r.row.name)),
);

async function run() {
  phase.value = "running";
  rows.value = [];
  ticked.value = new Set();
  const list = names.value;
  asked.value = list.length;
  // typed but not yet saved (Start clicked before the field lost focus)
  if (wiki.value.trim() !== (libraryStore.bookById(props.bookId)?.wiki ?? "")) saveWiki();
  await saving;
  if (!open.value) return;
  stop = new AbortController();
  await castStore.wikiFills(props.bookId, list, {
    signal: stop.signal,
    onRow: (row) => {
      rows.value.push(row);
      const c = byName.value?.get(row.name);
      if (c && fillChips(c, row.fill).length) ticked.value.add(row.name);
    },
  });
  stop = null;
  if (open.value) phase.value = "review";
}
function toggle(name: string) {
  const next = new Set(ticked.value);
  if (!next.delete(name)) next.add(name);
  ticked.value = next;
}
function apply() {
  castStore.applyWikiFills(
    props.bookId,
    toApply.value.map((r) => r.row),
  );
  open.value = false;
}
</script>

<template>
  <UiDialog v-model:open="open" placement="top" class="card w-[min(560px,94vw)] space-y-3 p-4">
    <DialogTitle class="font-semibold">Fill from wiki</DialogTitle>
    <DialogDescription class="sr-only">
      Only age, gender and voice type are taken from speakers’ wiki pages.
    </DialogDescription>

    <template v-if="phase === 'setup'">
      <div class="space-y-1 text-xs font-medium">
        <div class="flex items-center gap-1">
          <label for="wiki-address">Wiki address</label>
          <UiHint
            label="the wiki address"
            text="Speakers’ pages are looked up here by name and aliases. Only age, gender and voice type are taken."
          />
        </div>
        <input
          id="wiki-address"
          v-model="wiki"
          class="input w-full"
          placeholder="https://…fandom.com"
          inputmode="url"
          @change="saveWiki"
        />
        <p v-if="badWiki" class="font-normal text-amber-600 dark:text-amber-400">
          Not a web address: start it with https://
        </p>
      </div>

      <div class="space-y-1.5 text-sm" role="radiogroup" aria-label="Which speakers to look up">
        <label v-for="s in scopes" :key="s.value" class="flex items-center gap-2">
          <input v-model="scope" type="radio" :value="s.value" class="accent-violet-600" />
          {{ s.label }} <span class="text-zinc-400">· {{ s.names.length }}</span>
        </label>
      </div>

      <p class="text-xs text-zinc-500">
        <template v-if="profile"
          >≈{{ plural(names.length, "request") }} on {{ profile.name }}</template
        >
        <template v-if="picked?.skipped">
          · {{ picked.skipped }} persona or masked skipped
          <UiHint
            label="skipped speakers"
            text="Personas and masked speakers aren’t looked up: their page could give away who they are."
          />
        </template>
      </p>
      <p v-if="castStore.aiBlocker" class="text-xs text-amber-600 dark:text-amber-400">
        {{ castStore.aiBlocker }}
      </p>

      <div class="flex justify-end gap-2">
        <button class="btn-ghost btn-xs" @click="open = false">Cancel</button>
        <button
          class="btn-primary btn-xs"
          :disabled="!!why || badWiki"
          :data-tip="why"
          @click="run"
        >
          Start
        </button>
      </div>
    </template>

    <template v-else>
      <div v-if="phase === 'running'" class="flex items-center gap-3 text-sm">
        <div class="h-1.5 flex-1 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
          <div
            class="h-full bg-violet-500 transition-all"
            :style="{ width: `${(rows.length / Math.max(asked, 1)) * 100}%` }"
          ></div>
        </div>
        <span class="tabular-nums" aria-live="polite">{{ rows.length }} of {{ asked }}</span>
        <button class="btn-ghost btn-xs" @click="halt">Stop</button>
      </div>
      <p v-else-if="rows.length < asked" class="text-xs text-zinc-500">
        Stopped after {{ rows.length }} of {{ asked }}
      </p>

      <ul
        v-if="rows.length"
        class="max-h-[50vh] divide-y divide-zinc-100 overflow-y-auto text-sm dark:divide-zinc-800"
      >
        <li v-for="{ row, chips } in review" :key="row.name" class="flex gap-2 py-1.5">
          <input
            type="checkbox"
            class="mt-1 accent-violet-600"
            :checked="ticked.has(row.name)"
            :disabled="!chips.length"
            :aria-label="`Fill ${row.name}`"
            @change="toggle(row.name)"
          />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1">
              <b class="mr-1">{{ row.name }}</b>
              <span v-for="chip in chips" :key="chip" class="chip chip-on">{{ chip }}</span>
              <span v-if="!chips.length" class="text-xs text-zinc-400">nothing new</span>
              <span v-if="row.url" class="ml-auto text-xs">
                <SpoilerText :text="row.url" label="page · show" small>
                  <a
                    :href="row.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-violet-600 hover:underline dark:text-violet-300"
                    >page</a
                  >
                </SpoilerText>
              </span>
            </div>
            <div
              v-if="row.notes.length"
              class="truncate text-[11px] text-zinc-400"
              :data-tip="row.notes.join(' · ')"
            >
              {{ row.notes.join(" · ") }}
            </div>
          </div>
        </li>
      </ul>

      <div v-if="phase === 'review'" class="flex items-center justify-end gap-2">
        <span v-if="!toApply.length" class="mr-auto text-xs text-zinc-500"
          >Nothing new to fill</span
        >
        <button class="btn-ghost btn-xs" @click="open = false">Close</button>
        <button class="btn-primary btn-xs" :disabled="!toApply.length" @click="apply">
          Apply {{ toApply.length }}
        </button>
      </div>
    </template>
  </UiDialog>
</template>
