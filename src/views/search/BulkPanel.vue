<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptsStore } from "@/stores/scripts";

// The bulk action bar's own panel: it opens in place, under the buttons, rather than over the results
// it is about. Same idea as the ledger's row detail — a violet rail, a strip of labelled facts, and
// tinted callouts for the things that cost something — so the numbers can be read at a glance instead
// of parsed out of a sentence.
//
// Configuring and closing mutate nothing: `bulkPreview` only reads. The footer button names the exact
// work and is dead when there is none.
import { computed, nextTick, ref, watch } from "vue";
import {
  TriangleAlert as WarnIcon,
  ChevronDown as OpenIcon,
  ChevronRight as ClosedIcon,
  ArrowRight as ToIcon,
} from "@lucide/vue";
import { FLAG_LABEL } from "@/lib/scriptReview";
import { directionOptions } from "@/lib/bulk";
import { UiCombobox, UiToggleGroup, UiSwitch } from "@/ui";
import type { BulkAction, BulkResult, BulkTarget, FlagKind } from "@/types";

const props = defineProps<{
  bookId: string;
  /** which of the three corrections this panel is configuring; null when it is closed */
  kind: "speaker" | "direction" | "flag" | null;
  targets: BulkTarget[];
}>();
const emit = defineEmits<{ close: []; applied: [BulkResult] }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const scriptsStore = useScriptsStore();

const root = ref<HTMLElement | null>(null);
const speaker = ref("");
const mode = ref<"set" | "clear">("set");
const direction = ref("");
const flag = ref<FlagKind>("delivery");
const note = ref("");
const replace = ref(false);
const expanded = ref(false);
/** the state of the selected lines when this preview was taken; a drift means it is out of date */
const base = ref("");

const cast = computed(() => castStore.charactersOf(props.bookId));
const counts = computed(() => scriptsStore.lineCounts(props.bookId));
const castOpts = computed(() =>
  [...cast.value]
    .sort((a, b) => Number(b.major) - Number(a.major) || a.name.localeCompare(b.name))
    .map((c) => ({
      value: c.name,
      label: c.name,
      color: c.color,
      group: c.major ? "Main cast" : "Also in the script",
      hint: c.voice ? endpointsStore.voiceLabel(c.voice) : "no voice yet",
      keywords: [c.aliases.join(" "), `${counts.value[c.name] ?? 0} lines`].join(" "),
    })),
);
const dirOpts = computed(() => directionOptions(scriptsStore.segments, props.bookId));
const KINDS: FlagKind[] = ["pronunciation", "delivery", "pause", "other"];

// a fresh form each time the bar opens a panel, and the focus lands in it
watch(
  () => props.kind,
  async (k) => {
    if (!k) return;
    speaker.value = "";
    mode.value = "set";
    direction.value = "";
    flag.value = "delivery";
    note.value = "";
    replace.value = false;
    expanded.value = false;
    base.value = "";
    await nextTick();
    root.value?.querySelector<HTMLElement>("[data-first] input, [data-first] button")?.focus();
  },
);

/** Enough has been filled in to say what would happen. An empty direction is never "clear". */
const ready = computed(() => {
  if (props.kind === "speaker") return !!speaker.value;
  if (props.kind === "direction") return mode.value === "clear" || !!direction.value.trim();
  return true;
});
const action = computed<BulkAction | null>(() => {
  if (!ready.value) return null;
  if (props.kind === "speaker") return { kind: "speaker", speaker: speaker.value };
  if (props.kind === "direction")
    return { kind: "direction", mode: mode.value, direction: direction.value };
  if (props.kind === "flag")
    return { kind: "flag", flag: flag.value, note: note.value, replace: replace.value };
  return null;
});
const preview = computed(() =>
  action.value ? scriptsStore.bulkPreview(props.bookId, props.targets, action.value) : null,
);
// the first preview of this selection is the one the numbers are promised against
watch(preview, (p) => {
  if (p && !base.value) base.value = p.signature;
});
const drifted = computed(
  () => !!preview.value && !!base.value && preview.value.signature !== base.value,
);
const examples = computed(() => preview.value?.rows.filter((r) => r.changes).slice(0, 2) ?? []);

// --- what the change means for narration
const voice = computed(() =>
  speaker.value ? castStore.effectiveVoice(props.bookId, speaker.value) : null,
);
const narratorVoice = computed(() =>
  endpointsStore.voiceLabel(castStore.effectiveVoice(props.bookId, "Narrator").ref),
);
const segOf = (t: BulkTarget) =>
  scriptsStore.segmentsOf(props.bookId, t.chId).find((s) => s.id === t.segId);
const withDirection = computed(() => props.targets.filter((t) => segOf(t)?.direction).length);
const alreadyFlagged = computed(() => props.targets.filter((t) => segOf(t)?.flag).length);
const chapters = computed(() => new Set(props.targets.map((t) => t.chId)).size);

/** The preview as the ledger renders an audit trail: a label above each number. */
interface Fact {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn" | "strong";
  wide?: boolean;
}
const facts = computed<Fact[]>(() => {
  const p = preview.value;
  if (!p) return [];
  const out: Fact[] = [
    {
      label: "selected",
      value: `${p.selected} line${p.selected === 1 ? "" : "s"}`,
      hint: `in ${chapters.value} ch`,
    },
    {
      label: "will change",
      value: String(p.changing),
      tone: p.changing ? "strong" : undefined,
    },
    {
      label: "unchanged",
      value: p.skipped ? String(p.skipped) : "none",
      hint: p.skipped ? p.skipReason : "",
      wide: !!p.skipped,
    },
  ];
  if (p.missing) out.push({ label: "gone", value: String(p.missing), tone: "warn" });
  out.push(
    action.value?.kind === "flag"
      ? { label: "clips", value: "untouched", hint: "flags never stale audio" }
      : {
          label: "clips going stale",
          value: p.stale ? String(p.stale) : "none",
          tone: p.stale ? "warn" : undefined,
        },
  );
  return out;
});

const TITLE = {
  speaker: "Change speaker",
  direction: "Set or clear direction",
  flag: "Flag for review",
} as const;

function apply() {
  if (!action.value || !preview.value?.changing || drifted.value) return;
  emit("applied", scriptsStore.applyBulk(props.bookId, props.targets, action.value));
  emit("close");
}
</script>

<template>
  <section
    v-if="kind"
    id="bulk-panel"
    ref="root"
    role="group"
    :aria-label="TITLE[kind]"
    class="border-t border-zinc-200 bg-zinc-50/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/60"
    @keydown.esc.stop="emit('close')"
  >
    <div class="border-l-2 border-violet-400 pl-3 text-xs dark:border-violet-500">
      <div class="label mb-1.5">{{ TITLE[kind] }}</div>

      <!-- the correction -->
      <div class="flex flex-wrap items-center gap-2">
        <template v-if="kind === 'speaker'">
          <span data-first
            ><UiCombobox
              v-model="speaker"
              :options="castOpts"
              size="xs"
              placeholder="Search the cast…"
              block
              class="w-56"
          /></span>
          <span v-if="voice?.own" class="text-zinc-500"
            >read by
            <b class="font-medium text-zinc-700 dark:text-zinc-300">{{
              endpointsStore.voiceLabel(voice.ref)
            }}</b></span
          >
        </template>

        <template v-else-if="kind === 'direction'">
          <span data-first
            ><UiToggleGroup
              :model-value="mode"
              :options="[
                { value: 'set', label: 'Set a direction', class: 'normal-case' },
                { value: 'clear', label: 'Clear existing directions', class: 'normal-case' },
              ]"
              @update:model-value="(v) => (mode = v as 'set' | 'clear')"
          /></span>
          <UiCombobox
            v-if="mode === 'set'"
            v-model="direction"
            :options="dirOpts"
            custom
            size="xs"
            placeholder="e.g. whispered, hesitant"
            block
            class="w-64"
          />
          <span v-if="mode === 'clear'" class="text-zinc-400"
            >removes the delivery note from every selected line that has one</span
          >
          <span v-else class="text-zinc-400"
            >expression tags in the text are a separate feature and are left alone</span
          >
        </template>

        <template v-else>
          <span data-first
            ><UiToggleGroup
              :model-value="flag"
              :options="KINDS.map((k) => ({ value: k, label: k }))"
              @update:model-value="(v) => (flag = v as FlagKind)"
          /></span>
          <input
            v-model="note"
            class="input min-w-0 flex-1 py-0.5 text-xs"
            placeholder="note — e.g. “the whole scene is read too fast”"
            :aria-label="`Note saved with every ${FLAG_LABEL[flag]} flag in this batch`"
          />
          <UiSwitch v-model="replace"
            >Replace existing flags
            <span class="text-zinc-400">— off, they are kept</span></UiSwitch
          >
        </template>
      </div>

      <!-- what it would do, as an audit strip -->
      <div v-if="preview" class="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
        <div
          v-for="f in facts"
          :key="f.label"
          class="min-w-0"
          :class="f.wide ? 'min-w-[9rem] flex-1' : 'max-w-[220px]'"
        >
          <div class="text-[9px] uppercase tracking-wider text-zinc-400">{{ f.label }}</div>
          <div
            class="truncate"
            :class="[
              f.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
              f.tone === 'strong' && 'font-semibold',
            ]"
          >
            {{ f.value }}<span v-if="f.hint" class="ml-1 text-zinc-400">{{ f.hint }}</span>
          </div>
        </div>
      </div>

      <!-- the things that cost something -->
      <div
        v-if="voice && !voice.own"
        class="mt-2 flex flex-wrap items-center gap-2 rounded bg-amber-400/10 px-2 py-1 text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon shrink-0" />
        <span class="min-w-0 flex-1"
          ><b>{{ speaker }}</b> has no voice — the script correction is fine, but narrating these
          lines needs an assignment<span v-if="narratorVoice">
            (they would fall back to the Narrator’s {{ narratorVoice }})</span
          >.</span
        >
        <RouterLink
          :to="`/book/${bookId}/cast`"
          class="btn-ghost btn-xs shrink-0 border-amber-400 text-amber-700 dark:text-amber-300"
          >Assign one</RouterLink
        >
      </div>
      <div
        v-if="preview?.stale"
        class="mt-2 flex items-center gap-2 rounded bg-amber-400/10 px-2 py-1 text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon shrink-0" />
        <span
          >{{ preview.stale }} rendered clip{{ preview.stale === 1 ? "" : "s" }} will need
          regeneration — the audio is kept for comparison until you re-narrate.</span
        >
      </div>
      <div
        v-if="kind === 'direction' && mode === 'set' && !direction.trim()"
        class="mt-2 flex items-center gap-2 rounded bg-amber-400/10 px-2 py-1 text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon shrink-0" />
        <span
          >Pick or type a direction. An empty field clears nothing — use
          <b>Clear existing directions</b> for that.</span
        >
      </div>
      <div
        v-else-if="kind === 'direction' && mode === 'set' && withDirection"
        class="mt-2 rounded bg-violet-500/5 px-2 py-1"
      >
        <span class="text-[9px] uppercase tracking-wider text-zinc-400">replaces</span>
        <span class="ml-1.5"
          >{{ withDirection }} selected line{{ withDirection === 1 ? "" : "s" }} already
          {{ withDirection === 1 ? "carries" : "carry" }} a direction</span
        >
      </div>
      <div v-if="kind === 'flag' && alreadyFlagged" class="mt-2 rounded bg-violet-500/5 px-2 py-1">
        <span class="text-[9px] uppercase tracking-wider text-zinc-400">already flagged</span>
        <span class="ml-1.5"
          >{{ alreadyFlagged }} selected line{{ alreadyFlagged === 1 ? "" : "s" }} —
          {{
            replace
              ? "their flags and notes will be replaced"
              : "their flags are kept, and they are skipped"
          }}</span
        >
      </div>
      <div
        v-if="drifted"
        class="mt-2 flex flex-wrap items-center gap-2 rounded bg-amber-400/10 px-2 py-1 text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon shrink-0" />
        <span class="min-w-0 flex-1"
          >A selected line was edited elsewhere — these numbers are out of date.</span
        >
        <button
          class="btn-ghost btn-xs shrink-0 border-amber-400"
          @click="base = preview!.signature"
        >
          Refresh
        </button>
      </div>

      <!-- before / after, two lines of it -->
      <div v-if="examples.length" class="mt-2 space-y-1">
        <div
          v-for="r in examples"
          :key="`${r.chId}:${r.segId}`"
          class="flex min-w-0 items-baseline gap-2 rounded bg-violet-500/5 px-2 py-1"
        >
          <span class="shrink-0 font-mono text-[10px] text-zinc-400"
            >{{ String(r.chId).padStart(2, "0") }}·#{{ r.segId }}</span
          >
          <span class="shrink-0 whitespace-nowrap">
            <span class="text-zinc-500 line-through">{{ r.before }}</span>
            <ToIcon class="icon-sm mx-1 text-zinc-400" />
            <b class="text-violet-700 dark:text-violet-300">{{ r.after }}</b>
          </span>
          <span class="min-w-0 flex-1 truncate text-zinc-500">{{ r.text }}</span>
          <span v-if="r.stale" class="shrink-0 text-[10px] text-amber-600">clip stale</span>
        </div>
      </div>

      <!-- every affected line, on request -->
      <div
        v-if="expanded && preview"
        class="mt-2 max-h-52 overflow-y-auto rounded border border-zinc-200 dark:border-zinc-700"
      >
        <div
          v-for="r in preview.rows"
          :key="`all-${r.chId}:${r.segId}`"
          class="flex flex-wrap items-baseline gap-x-2 border-b border-zinc-100 px-2 py-1 text-[11px] last:border-0 dark:border-zinc-800"
          :class="!r.changes && 'opacity-60'"
        >
          <span class="font-mono text-zinc-400"
            >{{ String(r.chId).padStart(2, "0") }}·#{{ r.segId }}</span
          >
          <span
            class="rounded-full px-1.5"
            :style="{ background: r.color + '33', color: r.color }"
            >{{ r.speaker }}</span
          >
          <span class="min-w-0 flex-1 truncate text-zinc-500">{{ r.text }}</span>
          <span v-if="r.changes" class="shrink-0"
            ><span class="text-zinc-400 line-through">{{ r.before }}</span>
            <ToIcon class="icon-sm mx-0.5 text-zinc-400" />
            <b class="text-violet-700 dark:text-violet-300">{{ r.after }}</b></span
          >
          <span v-else class="shrink-0 text-zinc-400">{{ r.skip }}</span>
        </div>
      </div>

      <!-- act -->
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button v-if="preview" class="chip" :aria-expanded="expanded" @click="expanded = !expanded">
          <component :is="expanded ? OpenIcon : ClosedIcon" class="icon-sm" />
          {{ expanded ? "Hide" : "Inspect" }} all {{ preview.rows.length }}
        </button>
        <span v-else class="text-zinc-400"
          >Fill the correction in to see what it would change.</span
        >
        <span class="ml-auto text-[11px] text-zinc-400">closing changes nothing</span>
        <div class="flex shrink-0 items-center gap-2">
          <button class="btn-ghost btn-xs" @click="emit('close')">Cancel</button>
          <button
            class="btn-primary btn-xs"
            :disabled="!preview || !preview.changing || drifted"
            @click="apply"
          >
            {{ preview ? preview.confirm : "Nothing to change" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
