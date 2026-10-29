<script setup lang="ts">
// A book's scripting prompt layer: notes for `{{book.notes}}`, or a whole replacement prompt (see
// `@/lib/prompt`). Warns when the prompt in force drops the notes' tag. The draft saves on idle or
// blur; an invalid draft stays here with its reasons and is not written.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useEndpointsStore } from "@/stores/endpoints";
import { storedBookPrompt, useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useCast, useChapterText, useEffects } from "@/queries";
import {
  bookPromptProblems,
  describeOrigin,
  libraryPrompt,
  lineEffectsOf,
  NOTES_MAX_CHARS,
  notesProblems,
  renderPrompt,
  resolvePrompt,
} from "@/lib/prompt";
import { droppedNotes, withNotesLine, type NotesOwner } from "@/lib/promptNotes";
import { expressionNames } from "@/lib/expressions";
import { scriptParts } from "@/lib/scripting";
import { personaOwner, whoOf } from "@/lib/cast";
import PromptEditor from "@/components/PromptEditor.vue";
import PromptTrial from "@/components/PromptTrial.vue";
import { UiSwitch } from "@/ui";
import { TriangleAlert as WarnIcon } from "@lucide/vue";
import type { BookPrompt, RenderedPrompt } from "@/types";

const props = defineProps<{ bookId: string }>();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();

const SAVE_AFTER_MS = 800;
/** Built here: literal braces in the template would end the interpolation. */
const NOTES_TAG = "{{book.notes}}";
const ENDPOINT_NOTES_TAG = "{{endpoint.notes}}";

const book = computed(() => libraryStore.bookById(props.bookId));
const EMPTY: BookPrompt = { notes: "", replace: false, system: "", user: "" };
const saved = (): BookPrompt => {
  const p = book.value?.prompt;
  return {
    notes: p?.notes ?? "",
    replace: !!p?.replace,
    system: p?.system ?? "",
    user: p?.user ?? "",
  };
};
const draft = ref<BookPrompt>(saved());
// whitespace-only notes count as none
const dirty = computed(
  () =>
    JSON.stringify(storedBookPrompt(draft.value) ? draft.value : EMPTY) !== JSON.stringify(saved()),
);
const problems = computed(() => bookPromptProblems(draft.value));
const notesTooLong = computed(() => notesProblems(draft.value.notes).length > 0);
const replaceProblems = computed(() => problems.value.length > (notesTooLong.value ? 1 : 0));

let timer: ReturnType<typeof setTimeout> | null = null;
function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (dirty.value && !problems.value.length)
    void libraryStore.setBookPrompt(props.bookId, { ...draft.value });
}
watch(
  draft,
  () => {
    if (timer) clearTimeout(timer);
    timer = dirty.value && !problems.value.length ? setTimeout(flush, SAVE_AFTER_MS) : null;
  },
  { deep: true },
);
// show the server's copy unless there is unsaved typing
watch(
  () => JSON.stringify(saved()),
  () => {
    if (!timer) draft.value = saved();
  },
);
onBeforeUnmount(flush);

/** also what reset puts back */
const libraryDefault = computed(() => libraryPrompt(endpointsStore.prompt));

const replace = computed({
  get: () => draft.value.replace,
  set(on: boolean) {
    // an empty replacement starts from what the book would otherwise be sent
    if (on && !draft.value.system.trim() && !draft.value.user.trim())
      Object.assign(draft.value, libraryDefault.value);
    draft.value.replace = on;
  },
});

// ---- what a run of the chosen endpoint would send ----

const profile = computed(() => scriptingStore.runProfile);
const resolved = computed(() =>
  resolvePrompt({
    library: endpointsStore.prompt,
    profile: profile.value?.prompt,
    book: draft.value,
  }),
);
/** notes whose tag the prompt in force lacks, so they are not sent */
const dropped = computed(() =>
  droppedNotes(
    resolved.value,
    { book: draft.value.notes, endpoint: profile.value?.prompt?.notes },
    profile.value?.name ?? "",
    "book",
  ),
);
/** Appends `owner`'s notes tag to this book's system prompt. */
function addTag(owner: NotesOwner) {
  draft.value.system = withNotesLine(draft.value.system, owner);
}

// the preview uses the first kept chapter; the trial picks its own
const chapter = computed(() => {
  const chapters = libraryStore.chaptersOf(props.bookId);
  return chapters.find((c) => !c.excluded) ?? chapters[0];
});
const { text } = useChapterText(
  () => props.bookId,
  () => chapter.value?.id,
  "plain",
);
const { characters } = useCast(() => props.bookId);
const { effects } = useEffects();
const parts = computed(() => {
  const p = profile.value;
  const cut = p ? scriptParts(text.value, p) : [];
  return cut.length ? cut : [text.value];
});
const byName = computed(() => new Map(characters.value.map((c) => [c.name, c])));
const preview = computed<RenderedPrompt | null>(() => {
  const b = book.value;
  const ch = chapter.value;
  if (!b || !ch) return null;
  return renderPrompt(resolved.value, {
    book: { title: b.title, author: b.author, notes: draft.value.notes },
    chapter: { title: ch.title, number: libraryStore.numberOf(props.bookId, ch.id) ?? ch.id },
    part: 1,
    parts: parts.value.length,
    // personaOf only when that character is in the cast, as in a run
    cast: characters.value.map((c) => ({
      name: c.name,
      aliases: c.aliases,
      gender: c.gender,
      description: whoOf(c),
      ...(personaOwner(c, byName.value) ? { personaOf: c.personaOf } : {}),
    })),
    excerpt: parts.value[0] ?? "",
    endpoint: {
      name: profile.value?.name ?? "",
      model: profile.value?.model ?? "",
      notes: profile.value?.prompt?.notes ?? "",
    },
    expressions: expressionNames(endpointsStore.endpoints),
    lineEffects: lineEffectsOf(effects.value),
  });
});
const previewOf = computed(
  () =>
    `${chapter.value?.title ?? "the first chapter"}, request 1 of ${parts.value.length}` +
    (profile.value ? ` as ${profile.value.name} cuts it` : ""),
);
</script>
<template>
  <div class="space-y-2" @focusout="flush">
    <div>
      <label :for="`notes-${bookId}`" class="font-medium">Notes for the scripter</label>
      <p class="text-[11px] leading-snug text-zinc-500">
        Placed where the prompt says <code class="font-mono">{{ NOTES_TAG }}</code
        >, in every request for this book.
      </p>
    </div>
    <textarea
      :id="`notes-${bookId}`"
      v-model="draft.notes"
      rows="3"
      class="input w-full resize-y leading-relaxed"
      placeholder="e.g. Dialogue is marked with em-dashes, not quotation marks. 'The Captain' is Aldous Varn."
    ></textarea>
    <p
      v-if="draft.notes.length > NOTES_MAX_CHARS * 0.75"
      class="flex justify-between gap-2 text-[11px] leading-snug"
      :class="notesTooLong ? 'text-red-700 dark:text-red-300' : 'text-zinc-400'"
    >
      <span>{{ notesProblems(draft.notes)[0] }}</span
      ><span class="shrink-0 font-mono text-[10px]"
        >{{ draft.notes.length.toLocaleString("en") }} /
        {{ NOTES_MAX_CHARS.toLocaleString("en") }}</span
      >
    </p>
    <p
      v-for="d in dropped"
      :key="d.owner"
      class="flex gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400"
      role="status"
    >
      <WarnIcon class="icon-sm mt-px shrink-0" />
      <span
        >{{ d.text }} <template v-if="d.fixElsewhere">Add the tag in {{ d.fixElsewhere }}.</template
        ><button
          v-else
          type="button"
          class="font-medium underline decoration-dotted underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
          @click="addTag(d.owner)"
        >
          Add the tag
        </button></span
      >
    </p>

    <div class="rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/60">
      <UiSwitch v-model="replace" label="Use this book's own prompt" />
      <p class="mt-1 text-[11px] leading-snug text-zinc-500">
        <template v-if="replace"
          >In place of the library's prompt and any endpoint's own, for this book only. Notes are
          sent where it names <code class="font-mono">{{ NOTES_TAG }}</code> and
          <code class="font-mono">{{ ENDPOINT_NOTES_TAG }}</code
          >.</template
        >
        <template v-else
          >This book is sent the {{ describeOrigin(resolved.origin) }}. Switch on to write one for
          this book alone.</template
        >
      </p>
    </div>

    <PromptEditor
      v-if="replace"
      v-model:system="draft.system"
      v-model:user="draft.user"
      :preview="preview"
      :reset-to="libraryDefault"
      reset-label="Reset to the library's prompt"
    />
    <details v-else-if="preview" class="rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/60">
      <summary class="cursor-pointer select-none text-[11px] text-zinc-600 dark:text-zinc-300">
        Preview what is sent
      </summary>
      <p class="mt-1.5 text-[11px] leading-snug text-zinc-500">{{ previewOf }}.</p>
      <div v-for="m in ['system', 'user'] as const" :key="m" class="mt-2">
        <span class="label">{{ m === "system" ? "System" : "User" }}</span>
        <pre
          class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] leading-relaxed dark:bg-zinc-950/50"
          >{{ preview[m] }}</pre>
      </div>
    </details>
    <p v-if="replace && preview" class="text-[11px] leading-snug text-zinc-500">
      The preview is {{ previewOf }}.
    </p>

    <div class="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
      <PromptTrial
        :book-id="bookId"
        :chapter-id="null"
        :profile-id="profile?.id ?? ''"
        :drafts="{ book: draft }"
        :disabled="problems.length > 0"
        disabled-reason="Fix the problems above to try this prompt."
      />
    </div>

    <p
      v-if="dirty && problems.length"
      class="text-[11px] leading-snug text-red-700 dark:text-red-300"
      role="status"
    >
      Not saved until the
      {{ replaceProblems ? "problems above are fixed" : "notes are shorter" }}.
    </p>
  </div>
</template>
