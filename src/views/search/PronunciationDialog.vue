<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useScriptsStore } from "@/stores/scripts";

// "Add pronunciation…" — the search term, taken to the book's dictionary rather than replaced in the
// prose. The dictionary rewrites a term on its way to the endpoint and never touches the book text,
// so its scope is the whole book, not the selected results. An existing entry is detected and edited
// through the same `updateTerm` the Pronunciation panel uses.
import { computed, ref, watch } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { X as CloseIcon, TriangleAlert as WarnIcon } from "@lucide/vue";

import { hitsIn, marks, speak } from "@/lib/speech";
import type { LexEntry } from "@/types";

const props = defineProps<{ bookId: string; open: boolean; term: string }>();
const emit = defineEmits<{ close: [] }>();
const castStore = useCastStore();
const scriptsStore = useScriptsStore();

/** A whole search phrase is not a dictionary entry: prefill only something word-sized. */
const prefillable = (t: string) => {
  const v = t.trim();
  return !!v && v.length <= 32 && v.split(/\s+/).length <= 3;
};
const word = ref("");
const say = ref("");
const phrase = ref(false);

watch(
  () => [props.open, props.term],
  () => {
    if (!props.open) return;
    phrase.value = !!props.term.trim() && !prefillable(props.term);
    word.value = prefillable(props.term) ? props.term.trim() : "";
    const found = castStore.lexiconOf(props.bookId).find((e) => same(e.term, word.value));
    say.value = found?.say ?? "";
  },
  { immediate: true },
);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const existing = computed<LexEntry | undefined>(() =>
  word.value.trim()
    ? castStore.lexiconOf(props.bookId).find((e) => same(e.term, word.value))
    : undefined,
);
// re-read an existing entry's respelling when the user types their way onto one
watch(existing, (e) => {
  if (e && !say.value.trim()) say.value = e.say;
});

const draft = computed<LexEntry>(() => ({
  id: existing.value?.id ?? 0,
  term: word.value.trim(),
  say: say.value.trim(),
  enabled: true,
  matchCase: existing.value?.matchCase,
}));
/** The entry as the matcher sees it while the respelling is still being typed: `speak` ignores an
 *  entry with no replacement, and the count of matching lines should not wait for one. */
const probe = computed<LexEntry>(() => ({
  ...draft.value,
  say: draft.value.say || draft.value.term,
}));
/** How many lines of the whole book this entry would change, and one of them to look at. */
const scope = computed(() => {
  if (!draft.value.term) return { lines: 0, chapters: 0, sample: "" };
  const prefix = props.bookId + ":";
  let lines = 0;
  const chapters = new Set<string>();
  let sample = "";
  for (const k of Object.keys(scriptsStore.segments)) {
    if (!k.startsWith(prefix)) continue;
    for (const s of scriptsStore.segments[k])
      if (hitsIn(s.text, [probe.value]).length) {
        lines++;
        chapters.add(k);
        if (!sample) sample = s.text;
      }
  }
  return { lines, chapters: chapters.size, sample };
});
const before = computed(() => (scope.value.sample ? marks(scope.value.sample, [probe.value]) : []));
const after = computed(() =>
  scope.value.sample && draft.value.say ? speak(scope.value.sample, [draft.value]).text : "",
);
/** Rendered clips that carry the old pronunciation and would be marked stale. */
const staleClips = computed(() => {
  if (!draft.value.term || !draft.value.say) return 0;
  const prefix = props.bookId + ":";
  let n = 0;
  for (const k of Object.keys(scriptsStore.segments)) {
    if (!k.startsWith(prefix)) continue;
    for (const s of scriptsStore.segments[k]) {
      const sent = s.audio.pronounced ?? s.audio.said ?? s.audio.text;
      if (s.audio.status !== "done" || sent == null) continue;
      if (speak(s.text, [...castStore.lexiconOf(props.bookId), draft.value]).text !== sent) n++;
    }
  }
  return n;
});
const changed = computed(
  () => !existing.value || existing.value.say.trim() !== draft.value.say || !existing.value.enabled,
);
const valid = computed(() => !!draft.value.term && !!draft.value.say && changed.value);

function save() {
  if (!valid.value) return;
  if (existing.value)
    castStore.updateTerm(props.bookId, existing.value.id, { say: draft.value.say, enabled: true });
  else castStore.addTerm(props.bookId, draft.value.term, draft.value.say);
  emit("close");
}
</script>

<template>
  <DialogRoot
    :open="open"
    @update:open="
      (v) => {
        if (!v) emit('close');
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/40" />
      <!-- Esc, Cancel and the close button dismiss this; a stray click outside does not. -->
      <DialogContent
        @interact-outside="(e: Event) => e.preventDefault()"
        class="fixed left-1/2 top-1/2 z-50 flex max-h-[92dvh] w-[min(620px,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-2xl focus:outline-none dark:bg-zinc-950"
      >
        <header class="border-b border-zinc-200 p-4 dark:border-zinc-800">
          <div class="flex items-start gap-2">
            <DialogTitle class="text-lg font-semibold">{{
              existing ? "Edit the pronunciation" : "Add a pronunciation"
            }}</DialogTitle>
            <DialogClose class="btn-ghost btn-xs ml-auto" aria-label="Close"
              ><CloseIcon class="icon"
            /></DialogClose>
          </div>
          <DialogDescription class="mt-1 text-xs text-zinc-500"
            >The book text is never rewritten. The term is swapped on its way to the endpoint, so
            this applies to the whole book — not just the lines you selected or the results on
            screen.</DialogDescription
          >
        </header>

        <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <p
            v-if="phrase"
            class="rounded-md border border-amber-300 bg-amber-400/10 p-2.5 text-xs dark:border-amber-600/40"
          >
            <WarnIcon class="icon-sm text-amber-600" /> “{{ word || props.term }}” is a phrase, not
            a term — it was not filled in for you. Type the single word or name that is said
            wrongly.
          </p>
          <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_0.75rem_minmax(0,1fr)] sm:items-end">
            <label class="text-xs"
              >As written in the book
              <input
                v-model="word"
                class="input mt-1 w-full"
                placeholder="e.g. Lan’er"
                aria-label="Term as written in the book"
            /></label>
            <span class="hidden text-center text-zinc-400 sm:block sm:pb-2">→</span>
            <label class="text-xs"
              >Say it as
              <input
                v-model="say"
                class="input mt-1 w-full"
                placeholder="e.g. Lahn-urr"
                aria-label="How it should be said"
                @keydown.enter="save"
            /></label>
          </div>

          <p v-if="existing" class="text-xs text-violet-600 dark:text-violet-300">
            “{{ existing.term }}” is already in this book’s dictionary
            <span class="text-zinc-500"
              >(said “{{ existing.say }}”{{ existing.enabled ? "" : ", currently off" }})</span
            >
            — saving edits that entry instead of adding a second one.
          </p>

          <div v-if="draft.term" class="card space-y-2 p-3 text-xs">
            <div>
              <b>{{ scope.lines }}</b> line{{ scope.lines === 1 ? "" : "s" }} in
              <b>{{ scope.chapters }}</b> chapter{{ scope.chapters === 1 ? "" : "s" }} contain this
              term.
              <span v-if="!scope.lines" class="text-amber-600"
                ><WarnIcon class="icon-sm" /> Nothing in the scripted chapters matches it.</span
              >
            </div>
            <div v-if="staleClips" class="text-amber-600">
              {{ staleClips }} rendered clip{{ staleClips === 1 ? "" : "s" }} still read the old
              pronunciation and will need re-narration.
            </div>
            <template v-if="scope.sample">
              <div class="border-t border-zinc-200 pt-2 dark:border-zinc-800">
                <div class="label mb-1">In the book</div>
                <p class="leading-relaxed">
                  <template v-for="(m, i) in before" :key="i"
                    ><mark
                      v-if="m.say"
                      class="rounded bg-amber-300/60 px-0.5 dark:bg-amber-500/40"
                      >{{ m.text }}</mark
                    ><template v-else>{{ m.text }}</template></template
                  >
                </p>
              </div>
              <div v-if="after">
                <div class="label mb-1">Sent to the endpoint</div>
                <p class="leading-relaxed text-zinc-600 dark:text-zinc-400">{{ after }}</p>
              </div>
            </template>
          </div>
        </div>

        <footer
          class="flex flex-wrap items-center gap-2 border-t border-zinc-200 p-4 dark:border-zinc-800"
        >
          <RouterLink
            :to="`/book/${bookId}/narration`"
            class="text-xs text-zinc-500 underline hover:text-violet-500"
            >Open the full dictionary</RouterLink
          >
          <DialogClose class="btn-ghost ml-auto">Cancel</DialogClose>
          <button class="btn-primary" :disabled="!valid" @click="save">
            {{ existing ? "Update the entry" : "Add to the dictionary" }}
          </button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
