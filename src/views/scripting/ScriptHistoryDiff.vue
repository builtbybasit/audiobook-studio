<script setup lang="ts">
// What two versions of a chapter's script disagree on.
//
// The summary comes first — how many lines moved, and in what way — because on a long chapter the
// list is the wrong thing to read first. The list itself shows only what changed, filtered by kind,
// a page at a time, and every change says in words what it is: nothing here is told by colour
// alone. A rewritten line is shown as the two lines it reads as, with the words that went marked
// out of the first and the words that came marked in the second.
import { computed, ref, watch } from "vue";
import { comparisonSummary } from "@/lib/scriptHistory";
import { ArrowRight as ToIcon, CornerDownRight as JumpIcon } from "@lucide/vue";
import type { ChangeGroup, LineChange, ScriptComparison } from "@/types";

const props = withDefaults(
  defineProps<{
    comparison: ScriptComparison;
    /** what the two sides are called, in the reader's words */
    fromLabel: string;
    toLabel: string;
    /** the newer side is the current script, so a change can be opened in the reader */
    jumpable?: boolean;
  }>(),
  { jumpable: false },
);
const emit = defineEmits<{ jump: [id: number] }>();

const PAGE = 25;
const GROUPS: { id: ChangeGroup; label: string }[] = [
  { id: "text", label: "Words" },
  { id: "speaker", label: "Speakers" },
  { id: "direction", label: "Directions" },
  { id: "type", label: "Types" },
  { id: "expressions", label: "Expressions" },
  { id: "pause", label: "Pauses" },
  { id: "structure", label: "Split, joined, new, gone" },
];
const FIELD_LABEL: Record<string, string> = {
  text: "words",
  speaker: "speaker",
  direction: "direction",
  type: "type",
  expressions: "expressions",
  pause: "pause",
};
const KIND_LABEL: Record<LineChange["kind"], string> = {
  changed: "changed",
  added: "new line",
  removed: "line gone",
  split: "split in two",
  joined: "joined into one",
};

const filter = ref<ChangeGroup | "all">("all");
const shown = ref(PAGE);
const counts = computed(() =>
  GROUPS.map((g) => ({
    ...g,
    n: props.comparison.changes.filter((c) => c.groups.includes(g.id)).length,
  })).filter((g) => g.n),
);
const rows = computed(() =>
  filter.value === "all"
    ? props.comparison.changes
    : props.comparison.changes.filter((c) => c.groups.includes(filter.value as ChangeGroup)),
);
const visible = computed(() => rows.value.slice(0, shown.value));
const summary = computed(() => comparisonSummary(props.comparison));
/** What a row is called: the fields that moved, or the structural thing that happened to the line. */
const badges = (c: LineChange): string[] =>
  c.kind === "changed" ? c.fields.map((f) => FIELD_LABEL[f.field]) : [KIND_LABEL[c.kind]];
const ids = (list: number[]): string =>
  list.length ? list.map((id) => `#${id}`).join(" + ") : "—";
const textField = (c: LineChange) => c.fields.find((f) => f.field === "text");
/** A line whose words are the same and whose spacing is not: shown as it is written, breaks and all. */
const spacing = (c: LineChange): string => (c.kind === "changed" && textField(c)?.detail) || "";
const otherFields = (c: LineChange) => c.fields.filter((f) => f.field !== "text");
watch([() => props.comparison, filter], () => (shown.value = PAGE));
</script>

<template>
  <div class="min-h-0 space-y-3">
    <!-- the summary, before any of the detail -->
    <div class="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span class="text-sm font-semibold"
          >{{ comparison.lines }} line{{ comparison.lines === 1 ? "" : "s" }} differ</span
        >
        <span class="text-xs text-zinc-500"
          >between <b class="font-medium">{{ fromLabel }}</b> ({{ comparison.fromCount }} lines) and
          <b class="font-medium">{{ toLabel }}</b> ({{ comparison.toCount }} lines)</span
        >
      </div>
      <p v-if="comparison.identical" class="mt-1 text-xs text-zinc-500">
        These two read exactly the same: same words, same speakers, same directions, expressions and
        pauses.
      </p>
      <ul
        v-else
        class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300"
      >
        <li v-for="line in summary" :key="line" class="flex items-center gap-1.5">
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500"></span>{{ line }}
        </li>
      </ul>
    </div>

    <!-- what to look at -->
    <div v-if="!comparison.identical" class="flex flex-wrap items-center gap-1.5">
      <button class="chip" :class="filter === 'all' && 'chip-on'" @click="filter = 'all'">
        Everything <span class="text-zinc-400">{{ comparison.lines }}</span>
      </button>
      <button
        v-for="g in counts"
        :key="g.id"
        class="chip"
        :class="filter === g.id && 'chip-on'"
        @click="filter = g.id"
      >
        {{ g.label }} <span class="text-zinc-400">{{ g.n }}</span>
      </button>
    </div>

    <ul class="space-y-2">
      <li
        v-for="(c, i) in visible"
        :key="`${c.kind}-${c.fromIds.join()}-${c.toIds.join()}-${i}`"
        class="rounded-lg border border-zinc-200 p-2.5 text-xs dark:border-zinc-800"
      >
        <div class="mb-1.5 flex flex-wrap items-center gap-2">
          <span class="font-mono text-[10px] text-zinc-400"
            >{{ ids(c.fromIds) }} <ToIcon class="icon-sm" /> {{ ids(c.toIds) }}</span
          >
          <span
            v-for="b in badges(c)"
            :key="b"
            class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            >{{ b }}</span
          >
          <span class="truncate text-zinc-500">{{ c.speaker }}</span>
          <button
            v-if="jumpable && c.toIds.length"
            class="btn-ghost btn-xs ml-auto"
            :title="`Open line #${c.toIds[0]} in the reader`"
            @click="emit('jump', c.toIds[0])"
          >
            <JumpIcon class="icon-sm" /> Open the line
          </button>
        </div>

        <!-- a line cut in two, or two lines run into one: each side as the lines it reads as -->
        <div v-if="c.kind === 'split' || c.kind === 'joined'" class="space-y-1 font-serif">
          <p v-for="(t, k) in c.fromParts" :key="`f${k}`" class="flex gap-2">
            <span class="font-sans text-[11px] font-semibold text-zinc-400" aria-hidden="true"
              >&minus;</span
            >
            <span class="sr-only">Was:</span>
            <span class="font-sans text-[10px] text-zinc-400">#{{ c.fromIds[k] }}</span>
            <span class="min-w-0">{{ t }}</span>
          </p>
          <p v-for="(t, k) in c.toParts" :key="`t${k}`" class="flex gap-2">
            <span class="font-sans text-[11px] font-semibold text-zinc-400" aria-hidden="true"
              >+</span
            >
            <span class="sr-only">Now:</span>
            <span class="font-sans text-[10px] text-zinc-400">#{{ c.toIds[k] }}</span>
            <span class="min-w-0">{{ t }}</span>
          </p>
        </div>

        <!-- the words: the line as it read, then as it reads -->
        <div v-else-if="textField(c) || c.kind !== 'changed'" class="space-y-1 font-serif">
          <p v-if="c.fromText" class="flex gap-2">
            <span class="font-sans text-[11px] font-semibold text-zinc-400" aria-hidden="true"
              >&minus;</span
            >
            <span class="sr-only">Was:</span>
            <span class="min-w-0" :class="spacing(c) && 'whitespace-pre-wrap'"
              ><template v-if="c.runs.length"
                ><span
                  v-for="(r, k) in c.runs.filter((r) => r.kind !== 'add')"
                  :key="k"
                  :class="r.kind === 'remove' && 'bg-red-500/10 line-through decoration-red-500/70'"
                  >{{ r.text }}</span
                ></template
              ><template v-else>{{ c.fromText }}</template></span
            >
          </p>
          <p v-if="c.toText" class="flex gap-2">
            <span class="font-sans text-[11px] font-semibold text-zinc-400" aria-hidden="true"
              >+</span
            >
            <span class="sr-only">Now:</span>
            <span class="min-w-0" :class="spacing(c) && 'whitespace-pre-wrap'"
              ><template v-if="c.runs.length"
                ><span
                  v-for="(r, k) in c.runs.filter((r) => r.kind !== 'remove')"
                  :key="k"
                  :class="
                    r.kind === 'add' &&
                    'bg-emerald-500/10 font-semibold underline decoration-emerald-600/70 decoration-2'
                  "
                  >{{ r.text }}</span
                ></template
              ><template v-else>{{ c.toText }}</template></span
            >
          </p>
          <!-- no word moved, so there is nothing to mark: say what did move instead -->
          <p v-if="spacing(c)" class="font-sans text-[11px] text-zinc-500">
            {{ spacing(c) }} — the line breaks above are shown as they are written.
          </p>
        </div>

        <!-- everything else about the line -->
        <dl v-if="otherFields(c).length" class="mt-1.5 space-y-0.5">
          <div
            v-for="f in otherFields(c)"
            :key="f.field"
            class="flex flex-wrap items-baseline gap-2"
          >
            <dt class="w-20 shrink-0 text-[11px] text-zinc-400">{{ FIELD_LABEL[f.field] }}</dt>
            <dd class="min-w-0 flex-1">
              <span class="text-zinc-500 line-through decoration-zinc-400">{{ f.from }}</span>
              <ToIcon class="icon-sm mx-1 text-zinc-400" />
              <span class="font-medium">{{ f.to }}</span>
              <span v-if="f.detail" class="ml-1 text-zinc-400">({{ f.detail }})</span>
              <span v-if="f.field === 'pause'" class="ml-1 text-zinc-400"
                >— stitched, so no clip is affected</span
              >
            </dd>
          </div>
        </dl>
      </li>
    </ul>

    <div v-if="rows.length > visible.length" class="flex items-center gap-2 text-xs text-zinc-500">
      <button class="btn-ghost btn-xs" @click="shown += PAGE">
        Show {{ Math.min(PAGE, rows.length - visible.length) }} more
      </button>
      <button class="btn-ghost btn-xs" @click="shown = rows.length">
        Show all {{ rows.length }}
      </button>
      <span>{{ visible.length }} of {{ rows.length }} shown</span>
    </div>
    <p v-else-if="!rows.length && !comparison.identical" class="text-xs text-zinc-500">
      Nothing of that kind changed. Pick another filter.
    </p>
  </div>
</template>
