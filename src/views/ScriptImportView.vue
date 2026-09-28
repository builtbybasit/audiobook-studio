<script setup lang="ts">
// Importing a script file into this book. See docs/script-transfer.md#import.
//
// The server reads the file, matches its chapters to this book's by their source words and
// answers with a plan; nothing is written until **Apply** is pressed. The page reads top to bottom
// in the order things are decided — which chapters, which voices, then the button that names the
// work — and once applied it becomes the report of what happened, where the cast and dictionary
// differences the book kept can each be taken from the file after all.
import { computed, reactive, ref, watch } from "vue";
import { useBookId } from "@/composables/useBookId";
import { useCast } from "@/queries";
import { key } from "@/lib/scriptReview";
import { activeLibraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useLibraryStore } from "@/stores/library";
import { useTransferStore, type VoicePick } from "@/stores/transfer";
import { megabytes, useSpeakerSamplesStore } from "@/stores/speakerSamples";
import VoicePicker from "@/components/VoicePicker.vue";
import { UiCheckbox } from "@/ui";
import { plural } from "@/views/library/shared";
import { FileUp as FileIcon, X as ClearIcon } from "@lucide/vue";
import type {
  ImportChapter,
  RefusalReason,
  RestorePlan,
  VoiceRef,
  VoiceRow,
  VoiceRowSamples,
} from "@/types";

const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const historyStore = useHistoryStore();
const libraryStore = useLibraryStore();
const transferStore = useTransferStore();
const samplesStore = useSpeakerSamplesStore();
const bookId = useBookId();
useCast(bookId);

const serverless = !activeLibraryService();
const book = computed(() => libraryStore.bookById(bookId));
const plan = computed(() => transferStore.planOf(bookId));
const report = computed(() => transferStore.reportOf(bookId));
const reading = ref(false);

async function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  reading.value = true;
  try {
    await transferStore.readFile(bookId, file);
  } finally {
    reading.value = false;
  }
}

/** Each voice row's choice, reset whenever a new plan arrives — declared before the watcher that
 *  fills it, which runs at once. */
interface VoiceChoice {
  use: boolean;
  /** the voice to give them: an option of `here`, or one picked by Replace… */
  ref: VoiceRef | null;
}
const choices = reactive<Record<string, VoiceChoice>>({});

// ---------- chapters ----------
const busy = (c: ImportChapter) => historyStore.busyJobs(bookId, c.chapterId).length > 0;
const ticked = ref(new Set<number>());
watch(
  plan,
  (p) => {
    ticked.value = new Set((p?.chapters ?? []).filter((c) => !busy(c)).map((c) => c.chapterId));
    resetVoices();
  },
  { immediate: true },
);
/** The matched chapters, in this book's reading order, grouped by volume when there are several. */
const groups = computed(() => {
  const volumes = libraryStore.volumesOf(bookId);
  const rows = [...(plan.value?.chapters ?? [])].sort((a, b) => a.chapterId - b.chapterId);
  const by = new Map<number, ImportChapter[]>();
  for (const c of rows) {
    const v = libraryStore.chapter(bookId, c.chapterId)?.volumeId ?? 0;
    (by.get(v) ?? by.set(v, []).get(v)!).push(c);
  }
  return [...by].map(([id, chapters]) => ({
    id,
    name: volumes.find((v) => v.id === id)?.name ?? "",
    chapters,
  }));
});
const ordered = computed(() => groups.value.flatMap((g) => g.chapters));
const multi = computed(() => groups.value.length > 1);
const tickable = computed(() => ordered.value.filter((c) => !busy(c)));
const stateOf = (list: ImportChapter[]): boolean | "indeterminate" => {
  const open = list.filter((c) => !busy(c));
  const n = open.filter((c) => ticked.value.has(c.chapterId)).length;
  return n === 0 ? false : n === open.length ? true : "indeterminate";
};
function setAll(list: ImportChapter[], on: boolean) {
  const next = new Set(ticked.value);
  for (const c of list) {
    if (busy(c)) continue;
    if (on) next.add(c.chapterId);
    else next.delete(c.chapterId);
  }
  ticked.value = next;
}
const lastClicked = ref<number | null>(null);
function tick(c: ImportChapter, e: MouseEvent) {
  const on = !ticked.value.has(c.chapterId);
  const at = ordered.value.indexOf(c);
  const from = e.shiftKey && lastClicked.value != null ? lastClicked.value : at;
  const [lo, hi] = from < at ? [from, at] : [at, from];
  setAll(ordered.value.slice(lo, hi + 1), on);
  lastClicked.value = at;
}

/**
 * Each chapter's restore plan, worked out once per plan and current script rather than per render:
 * a preview is a full `planRestore` plus a comparison, and ticking a row must not redo 200 of them.
 */
const previews = computed(() => {
  const m = new Map<number, RestorePlan>();
  for (const c of ordered.value)
    if (!transferStore.loading[key(bookId, c.chapterId)])
      m.set(c.chapterId, transferStore.previewOf(bookId, c));
  return m;
});

/** What applying one chapter does, in the words the row shows. */
function consequence(c: ImportChapter): string {
  if (busy(c)) return "a run is in flight on this chapter — cancel it first";
  const r = previews.value.get(c.chapterId);
  if (!r) return "reading the current script…";
  if (r.comparison.identical) return "identical — nothing to do";
  const facts = [plural(r.comparison.lines, "line") + " change"];
  if (r.comparison.counts.text)
    facts.push(plural(r.comparison.counts.text, "line") + " with corrected words");
  if (r.stale) facts.push(plural(r.stale, "clip") + " go stale");
  if (r.dropped) facts.push(plural(r.dropped, "clip") + " dropped");
  if (r.kept) facts.push(plural(r.kept, "clip") + " kept");
  return facts.join(" · ");
}
const toApply = computed(() =>
  [...ticked.value].filter((id) => ordered.value.some((c) => c.chapterId === id)),
);

const REFUSED: Record<RefusalReason, string> = {
  unmatched: "No chapter of this book has these words",
  fidelity: "The lines stray too far from the chapter's words",
  malformed: "The file could not be read",
};

// ---------- voices ----------
function resetVoices() {
  for (const k of Object.keys(choices)) delete choices[k];
  for (const row of plan.value?.voices ?? [])
    choices[row.speaker] = {
      use: row.ticked,
      ref: row.match.kind === "here" ? (row.match.options[0]?.ref ?? null) : null,
    };
}
const voiceLabel = (ref: VoiceRef | null) =>
  ref ? endpointsStore.voiceLabel(ref) : "Narrator’s voice";
const usable = (row: VoiceRow) => row.match.kind === "public" || !!choices[row.speaker]?.ref;
const voiceRows = computed(() => plan.value?.voices ?? []);
const allVoices = computed<boolean | "indeterminate">(() => {
  const rows = voiceRows.value.filter(usable);
  const n = rows.filter((r) => choices[r.speaker]?.use).length;
  return n === 0 ? false : n === rows.length ? true : "indeterminate";
});
function useAllVoices(on: boolean) {
  for (const r of voiceRows.value) if (usable(r)) choices[r.speaker].use = on;
}
function replaceWith(row: VoiceRow, ref: VoiceRef | null) {
  choices[row.speaker] = { use: !!ref, ref };
}
const picks = computed<VoicePick[]>(() =>
  voiceRows.value.flatMap((row): VoicePick[] => {
    const c = choices[row.speaker];
    if (!c?.use) return [];
    if (row.match.kind === "public")
      return [
        {
          speaker: row.speaker,
          ref: `${row.match.endpointId}/${row.match.voice.id}`,
          add: { endpointId: row.match.endpointId, voice: row.match.voice },
        },
      ];
    return c.ref ? [{ speaker: row.speaker, ref: c.ref }] : [];
  }),
);

function apply() {
  transferStore.apply(bookId, toApply.value, picks.value);
}

/** The line a private voice's row gives the recordings the file carries for it. */
function samplesLine(s: VoiceRowSamples): string {
  if (s.kind === "refused") return `Samples not kept: ${s.reason}`;
  return (
    `Samples included · ${plural(s.count, "recording")}, ${megabytes(s.bytes)} · ` +
    `consent recorded ${new Date(s.consentAt).toLocaleDateString()}: “${s.consentText}”`
  );
}

// ---------- the report ----------
/** Each speaker whose samples the import kept, and where they can be cloned — once they are kept. */
const keptSamples = computed(() =>
  (report.value?.samples ?? []).map((speaker) => {
    const waiting = samplesStore.waitingFor(bookId, speaker);
    return { speaker, waiting, link: waiting ? samplesStore.cloneLink(bookId, waiting) : null };
  }),
);
const castNow = computed(() => castStore.charactersOf(bookId));
const lexNow = computed(() => castStore.lexiconOf(bookId));
/** The differences that still stand: one taken from the file drops off the list. */
const speakerDiffs = computed(() =>
  (plan.value?.cast.differ ?? []).filter((d) => {
    const c = castNow.value.find((x) => x.name === d.name);
    return (
      c &&
      (c.gender !== d.file.gender ||
        c.description !== d.file.description ||
        c.style !== d.file.style)
    );
  }),
);
const termDiffs = computed(() =>
  (plan.value?.lexicon.differ ?? []).filter((d) => {
    const e = lexNow.value.find((x) => x.term === d.term);
    return (
      e &&
      (e.say !== d.file.say ||
        (e.ipa ?? "") !== (d.file.ipa ?? "") ||
        (e.note ?? "") !== (d.file.note ?? "") ||
        !!e.matchCase !== !!d.file.matchCase ||
        e.enabled !== d.file.enabled)
    );
  }),
);
const SKIPPED = {
  identical: "already reads as the file does",
  busy: "a run was in flight",
  missing: "no longer in this book",
} as const;
</script>

<template>
  <div v-if="book" class="flex h-full min-h-0 flex-col">
    <div
      class="shrink-0 border-b border-zinc-200 bg-white px-4 py-3 sm:px-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div class="min-w-0">
          <div class="text-[11px] text-zinc-500">Import a script</div>
          <h1 class="truncate font-serif text-xl leading-tight">{{ book.title }}</h1>
          <div v-if="plan" class="text-xs text-zinc-500">
            <span class="font-mono">{{ plan.name }}</span
            ><template v-if="plan.title"> · scripted for “{{ plan.title }}”</template> ·
            {{ plural(plan.chapters.length, "chapter") }} matched<template
              v-if="plan.refused.length"
            >
              · {{ plan.refused.length }} refused</template
            >
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <button
            v-if="plan"
            class="btn-ghost"
            title="Put this file aside"
            @click="transferStore.forget(bookId)"
          >
            <ClearIcon class="icon-sm" /> Another file
          </button>
          <RouterLink :to="`/book/${bookId}/scripting`" class="btn-ghost"
            >Back to scripting</RouterLink
          >
        </div>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <!-- no server: there is nobody to read the file -->
        <section v-if="serverless" class="card p-4 text-sm">
          <p class="font-medium">Importing a script needs the server.</p>
          <p class="mt-1 text-xs text-zinc-500">
            A script file is matched to this book's chapters by the words of their source, which the
            server reads. Start the app with <code class="font-mono">pnpm dev</code> to import one.
          </p>
        </section>

        <!-- choosing the file -->
        <section v-else-if="!plan" class="card p-6 text-center">
          <FileIcon class="mx-auto h-8 w-8 text-zinc-400" />
          <p class="mt-2 text-sm font-medium">Choose a script file</p>
          <p class="mx-auto mt-1 max-w-md text-xs text-zinc-500">
            A <span class="font-mono">.script.zip</span> exported from a book, or one chapter's
            <span class="font-mono">.json</span>. Nothing is written until you apply it: you will
            see which chapters match, and what each one would change, first.
          </p>
          <label
            class="btn-primary mt-4 inline-flex cursor-pointer"
            :class="reading && 'opacity-60'"
          >
            {{ reading ? "Reading…" : "Choose file…" }}
            <input
              type="file"
              accept=".zip,.json,application/zip,application/json"
              class="hidden"
              :disabled="reading"
              @change="pick"
            />
          </label>
        </section>

        <!-- the report, once applied -->
        <template v-else-if="report">
          <section class="card p-4">
            <h2 class="text-sm font-semibold">
              {{ plural(report.applied.length, "chapter") }} imported
            </h2>
            <p class="mt-1 text-xs text-zinc-500">
              Each chapter's history keeps the script it replaced, labelled “Imported from
              {{ plan.name }}”. Undo in the toast takes the whole import back.
            </p>
            <ul v-if="report.skipped.length" class="mt-2 space-y-0.5 text-xs text-zinc-500">
              <li v-for="s in report.skipped" :key="s.chapterId">
                {{ s.title }} — {{ SKIPPED[s.why] }}
              </li>
            </ul>
            <p v-if="report.speakers.length" class="mt-2 text-xs">
              Added to the cast: {{ report.speakers.join(", ") }}
            </p>
            <p v-if="report.unused.length" class="mt-1 text-xs text-zinc-500">
              Not added, since no imported line uses them: {{ report.unused.join(", ") }}
            </p>
            <p v-if="report.terms" class="mt-1 text-xs">
              {{ plural(report.terms, "dictionary term") }} added
            </p>
            <p v-if="report.voices" class="mt-1 text-xs">
              {{ plural(report.voices, "voice") }} set
            </p>
          </section>

          <section v-if="keptSamples.length" class="card p-4">
            <h2 class="text-sm font-semibold">Voice samples waiting</h2>
            <p class="mt-1 text-xs text-zinc-500">
              The file carried the recordings these private voices were made from. They wait with
              the speaker until you clone them — nothing is cloned for you, and cloning asks for
              your own consent.
            </p>
            <div
              v-for="k in keptSamples"
              :key="k.speaker"
              class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800"
            >
              <span class="font-medium">{{ k.speaker }}</span>
              <span v-if="!k.waiting" class="text-zinc-500">keeping…</span>
              <template v-else>
                <span class="text-zinc-500"
                  >{{ plural(k.waiting.samples.length, "recording") }},
                  {{ megabytes(k.waiting.samples.reduce((n, x) => n + x.bytes, 0)) }}</span
                >
                <RouterLink
                  v-if="k.link"
                  :to="k.link"
                  class="ml-auto text-violet-700 hover:underline dark:text-violet-300"
                  >Clone on the Voices tab →</RouterLink
                >
                <RouterLink v-else to="/endpoints" class="ml-auto text-zinc-500 hover:underline"
                  >Add a Fish endpoint to clone this voice</RouterLink
                >
              </template>
            </div>
          </section>

          <section v-if="plan.refused.length || plan.ignored.length" class="card p-4">
            <h2 class="text-sm font-semibold">Not imported</h2>
            <ul class="mt-2 space-y-1 text-xs">
              <li v-for="r in plan.refused" :key="r.file">
                <span class="font-medium">{{ r.title || r.file }}</span>
                <span class="text-zinc-500"> — {{ REFUSED[r.reason] }}. {{ r.detail }}</span>
              </li>
              <li v-for="f in plan.ignored" :key="f" class="text-zinc-500">
                <span class="font-mono">{{ f }}</span> — not part of a script file, ignored
              </li>
            </ul>
          </section>

          <section v-if="speakerDiffs.length" class="card p-4">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold">Speakers the book described differently</h2>
              <button
                v-if="speakerDiffs.length > 1"
                class="btn-ghost btn-xs"
                @click="transferStore.useFileSpeakers(bookId, speakerDiffs)"
              >
                Replace all {{ speakerDiffs.length }}
              </button>
            </div>
            <p class="mt-1 text-xs text-zinc-500">The book's own descriptions were kept.</p>
            <div
              v-for="d in speakerDiffs"
              :key="d.name"
              class="mt-2 grid gap-2 border-t border-zinc-100 pt-2 text-xs sm:grid-cols-[8rem_1fr_1fr_auto] dark:border-zinc-800"
            >
              <div class="font-medium">{{ d.name }}</div>
              <div>
                <div class="text-[10px] uppercase text-zinc-400">This book</div>
                {{ d.book.gender }} · {{ d.book.description || "—" }}
                <div v-if="d.book.style" class="text-zinc-500">{{ d.book.style }}</div>
              </div>
              <div>
                <div class="text-[10px] uppercase text-zinc-400">The file</div>
                {{ d.file.gender }} · {{ d.file.description || "—" }}
                <div v-if="d.file.style" class="text-zinc-500">{{ d.file.style }}</div>
              </div>
              <button
                class="btn-ghost btn-xs self-start"
                @click="transferStore.useFileSpeakers(bookId, [d])"
              >
                Use the file's
              </button>
            </div>
          </section>

          <section v-if="termDiffs.length" class="card p-4">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-semibold">Terms the book pronounces differently</h2>
              <button
                v-if="termDiffs.length > 1"
                class="btn-ghost btn-xs"
                @click="transferStore.useFileTerms(bookId, termDiffs)"
              >
                Replace all {{ termDiffs.length }}
              </button>
            </div>
            <div
              v-for="d in termDiffs"
              :key="d.term"
              class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800"
            >
              <span class="font-medium">{{ d.term }}</span>
              <span>this book says “{{ d.book.say }}”</span>
              <span class="text-zinc-500">the file says “{{ d.file.say }}”</span>
              <button
                class="btn-ghost btn-xs ml-auto"
                @click="transferStore.useFileTerms(bookId, [d])"
              >
                Use the file's
              </button>
            </div>
          </section>
        </template>

        <!-- the plan -->
        <template v-else>
          <section class="card">
            <div
              class="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"
            >
              <UiCheckbox
                :model-value="stateOf(ordered)"
                :disabled="!tickable.length"
                aria-label="Every matched chapter"
                @update:model-value="(v) => setAll(ordered, v === true)"
              />
              <h2 class="text-sm font-semibold">Chapters</h2>
              <span class="text-xs text-zinc-500"
                >{{ toApply.length }} of {{ plural(ordered.length, "matched chapter") }} ticked ·
                shift-click ticks a range</span
              >
            </div>
            <p v-if="!ordered.length" class="px-4 py-3 text-xs text-zinc-500">
              No chapter of the file matched this book.
            </p>
            <div v-for="g in groups" :key="g.id">
              <div
                v-if="multi"
                class="flex items-center gap-2 bg-zinc-50 px-4 py-1 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800/50"
              >
                <UiCheckbox
                  size="xs"
                  :model-value="stateOf(g.chapters)"
                  :aria-label="`Every chapter of ${g.name}`"
                  @update:model-value="(v) => setAll(g.chapters, v === true)"
                />
                {{ g.name }}
              </div>
              <div
                v-for="c in g.chapters"
                :key="c.chapterId"
                class="flex items-start gap-2 border-t border-zinc-100 px-4 py-1.5 text-xs first:border-t-0 dark:border-zinc-800"
              >
                <UiCheckbox
                  class="mt-0.5"
                  :model-value="ticked.has(c.chapterId)"
                  :disabled="busy(c)"
                  :aria-label="c.title"
                  @click.prevent="tick(c, $event)"
                />
                <div class="min-w-0 flex-1">
                  <div class="truncate">
                    {{ c.title }}
                    <span v-if="c.fileTitle && c.fileTitle !== c.title" class="text-zinc-400"
                      >· “{{ c.fileTitle }}” in the file</span
                    >
                  </div>
                  <div class="text-[11px] text-zinc-500" :class="busy(c) && 'text-amber-600'">
                    {{ consequence(c) }}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section v-if="plan.refused.length" class="card p-4">
            <h2 class="text-sm font-semibold">Refused</h2>
            <p class="mt-1 text-xs text-zinc-500">
              A chapter whose source words differ from this book's — even by one corrected typo — is
              never applied.
            </p>
            <ul class="mt-2 space-y-1 text-xs">
              <li v-for="r in plan.refused" :key="r.file">
                <span class="font-medium">{{ r.title || r.file }}</span>
                <span v-if="r.words" class="text-zinc-400"> · {{ plural(r.words, "word") }}</span>
                <span class="text-zinc-500"> — {{ REFUSED[r.reason] }}. {{ r.detail }}</span>
              </li>
            </ul>
          </section>

          <section v-if="voiceRows.length" class="card">
            <div
              class="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"
            >
              <UiCheckbox
                :model-value="allVoices"
                aria-label="Use every voice from the file"
                @update:model-value="(v) => useAllVoices(v === true)"
              />
              <h2 class="text-sm font-semibold">Voices</h2>
              <span class="text-xs text-zinc-500"
                >ticked only where the speaker has no voice of their own yet</span
              >
            </div>
            <div
              v-for="row in voiceRows"
              :key="row.speaker"
              class="grid gap-2 border-t border-zinc-100 px-4 py-2 text-xs first:border-t-0 sm:grid-cols-[auto_8rem_1fr_1fr] dark:border-zinc-800"
            >
              <UiCheckbox
                class="mt-0.5"
                :model-value="!!choices[row.speaker]?.use"
                :disabled="!usable(row)"
                :aria-label="`Use the file's voice for ${row.speaker}`"
                @update:model-value="(v) => (choices[row.speaker].use = v === true)"
              />
              <div class="font-medium">
                {{ row.speaker }}
                <span v-if="row.isNew" class="text-[10px] font-normal text-violet-600">new</span>
              </div>
              <div class="text-zinc-500">{{ voiceLabel(row.current) }}</div>
              <div>
                <template v-if="row.match.kind === 'here'">
                  <select
                    v-if="row.match.options.length > 1"
                    v-model="choices[row.speaker].ref"
                    class="input py-0.5 text-xs"
                  >
                    <option v-for="o in row.match.options" :key="o.ref" :value="o.ref">
                      {{ row.hint.voiceLabel }} · {{ o.endpointName }}
                    </option>
                  </select>
                  <span v-else
                    >{{ row.hint.voiceLabel }} · {{ row.match.options[0]?.endpointName }}</span
                  >
                </template>
                <template v-else-if="row.match.kind === 'public'">
                  {{ row.hint.voiceLabel }}
                  <div class="text-[11px] text-zinc-500">
                    Add to {{ row.match.endpointName }} and use
                  </div>
                </template>
                <template v-else>
                  <div
                    v-if="row.match.kind === 'unchecked'"
                    class="text-amber-700 dark:text-amber-400"
                  >
                    {{ row.hint.voiceLabel }} — couldn’t check {{ row.hint.provider }}:
                    {{ row.match.reason }}
                  </div>
                  <div v-else class="text-zinc-500">
                    {{ row.hint.voiceLabel }} — a private voice on another account
                  </div>
                  <div
                    v-if="row.samples"
                    class="mt-0.5 text-[11px]"
                    :class="
                      row.samples.kind === 'refused'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-zinc-500'
                    "
                  >
                    {{ samplesLine(row.samples) }}
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-2">
                    <button
                      class="btn-ghost btn-xs"
                      :class="!choices[row.speaker]?.use && 'bg-zinc-100 dark:bg-zinc-800'"
                      @click="replaceWith(row, null)"
                    >
                      Keep
                    </button>
                    <VoicePicker
                      :model-value="choices[row.speaker]?.ref ?? null"
                      :book-id="bookId"
                      :speaker="row.speaker"
                      null-label="Replace…"
                      size="xs"
                      @update:model-value="(v) => replaceWith(row, v)"
                    />
                  </div>
                </template>
              </div>
            </div>
          </section>

          <div class="flex flex-wrap items-center justify-end gap-3">
            <span v-if="picks.length" class="text-xs text-zinc-500">
              and {{ plural(picks.length, "voice") }}
            </span>
            <button class="btn-primary" :disabled="!toApply.length" @click="apply">
              Apply {{ plural(toApply.length, "chapter") }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
