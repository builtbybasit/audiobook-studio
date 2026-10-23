<script setup lang="ts">
// The persona part of a speaker's record. A persona (a disguise) is read in its wearer's voice
// unless given its own. Who wears a mask the model linked stays behind a spoiler button.
import { computed, nextTick, ref } from "vue";

import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";

import { useBookSpend, useCast, useChapterTexts, useMentions } from "@/queries";
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { NARRATOR, personaOwner } from "@/lib/cast";
import { plural } from "@/lib/contents";
import { money } from "@/lib/pricing";
import { isScripted } from "@/lib/scriptReview";
import { UiCheckbox, UiHint, UiSelect } from "@/ui";
import SpoilerText from "@/components/SpoilerText.vue";
import ScriptProfileSelect from "@/views/scripting/ScriptProfileSelect.vue";
import { Plus as AddIcon, RotateCcw as RetryIcon, VenetianMask as MaskIcon } from "@lucide/vue";
import type { Character } from "@/types";

const props = defineProps<{
  bookId: string;
  c: Character;
  /** a speaker's lines in words ("12 lines", "some lines"), or null until counted */
  lines: (name: string) => string | null;
}>();

const castStore = useCastStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();
const { characters: cast } = useCast(props.bookId);
const byName = computed(() => castStore.byName[props.bookId] ?? new Map<string, Character>());
const owner = computed(() => personaOwner(props.c, byName.value));
// the personas of this speaker, in cast order
const mine = computed(() =>
  cast.value.filter((p) => personaOwner(p, byName.value)?.name === props.c.name),
);
// someone with personas of their own cannot be one: one level only, so a voice never chains
const ofOpts = computed(() =>
  cast.value
    .filter((x) => x.name !== props.c.name && x.name !== NARRATOR && !x.personaOf)
    .map((x) => ({ value: x.name, label: x.name, color: x.color })),
);
function link(of: string | number | null) {
  void castStore.updateCharacter(props.bookId, props.c.name, {
    personaOf: of == null ? undefined : String(of),
  });
}

// Scripted chapters naming the persona, per name, so an alias that is a common word can be
// unticked before anything is paid for.
const names = computed(() => (owner.value ? [...new Set([props.c.name, ...props.c.aliases])] : []));
const { byName: mentions, isLoading: finding } = useMentions(() => props.bookId, names);
const scripted = computed(
  () =>
    new Set(
      libraryStore
        .chaptersOf(props.bookId)
        .filter((ch) => isScripted(ch) && !ch.excluded)
        .map((ch) => ch.id),
    ),
);
const foundIn = (name: string) =>
  (mentions.value[name] ?? []).filter((id) => scripted.value.has(id));
const dropped = ref(new Set<string>());
function tickName(name: string) {
  const next = new Set(dropped.value);
  if (!next.delete(name)) next.add(name);
  dropped.value = next;
}
const toRescript = computed(() => {
  const ids = new Set(names.value.filter((n) => !dropped.value.has(n)).flatMap(foundIn));
  return [...ids].sort((a, b) => a - b);
});
const rescriptLabel = computed(() => {
  const n = toRescript.value.length;
  if (finding.value) return `Finding the chapters that mention “${props.c.name}”…`;
  if (!n) return `No scripted chapter of this book mentions “${props.c.name}”`;
  return `Re-script ${plural(n, "scripted chapter")} of this book that ${n === 1 ? "mentions" : "mention"} “${props.c.name}”…`;
});
// the estimate is priced on the chapters' text and held to the book's spending, read once it opens
const rescriptOpen = ref(false);
useChapterTexts(
  () => props.bookId,
  () => (rescriptOpen.value ? toRescript.value : []),
  "plain",
);
useBookSpend(() => (rescriptOpen.value ? props.bookId : null));
const estimate = computed(() =>
  rescriptOpen.value ? scriptingStore.scriptEstimate(props.bookId, toRescript.value) : null,
);
function rescript() {
  rescriptOpen.value = false;
  void scriptingStore.startRun(props.bookId, toRescript.value);
}

const adding = ref(false);
const draft = ref("");
const input = ref<HTMLInputElement | null>(null);
const taken = computed(() => cast.value.some((x) => x.name === draft.value.trim()));
async function startAdd() {
  adding.value = true;
  draft.value = "";
  await nextTick();
  input.value?.focus();
}
function add() {
  if (!draft.value.trim()) adding.value = false;
  else if (castStore.addCharacter(props.bookId, draft.value, props.c.name)) adding.value = false;
}
</script>

<template>
  <div class="space-y-2 text-xs">
    <div v-if="c.masked && !owner" class="flex flex-wrap items-center gap-2">
      <span
        class="inline-flex items-center gap-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-violet-600 dark:text-violet-300"
        ><MaskIcon class="icon-sm" aria-hidden="true" />Masked · identity unknown</span
      >
      <UiHint
        label="masked speakers"
        text="The scripting model found this speaker to be a disguise whose wearer the book has not named yet. It links them once a chapter does."
      />
      <button class="btn-ghost btn-xs" @click="castStore.unmask(bookId, c.name)">Not masked</button>
    </div>

    <div class="flex flex-wrap items-center gap-2 font-medium">
      <MaskIcon class="icon-sm text-zinc-500" aria-hidden="true" />
      Persona of
      <!-- who wears a mask the model linked is a spoiler until asked for -->
      <SpoilerText
        :text="owner?.name"
        :hidden="!!c.masked"
        label="found by the scripting model — spoilers · show"
        small
      >
        <UiSelect
          :model-value="owner?.name ?? null"
          :options="ofOpts"
          null-value="Not a persona"
          size="xs"
          class="w-48"
          :disabled="!!mine.length"
          :aria-label="`Who ${c.name} is a persona of`"
          @update:model-value="link"
      /></SpoilerText>
      <UiHint
        label="linking a persona"
        text="Link a masked stranger once the book says who they are. A voice of their own is kept after linking, so give them one before and the voice gives nothing away."
      />
      <span v-if="mine.length" class="font-normal text-zinc-500"
        >Not while {{ c.name }} has personas of their own.</span
      >
      <span v-else-if="owner" class="font-normal text-zinc-500">{{
        c.voice
          ? "Keeps a voice of their own."
          : `Read in ${c.masked ? "the wearer" : owner.name}’s voice unless given one of their own.`
      }}</span>
    </div>

    <div v-if="owner" class="flex flex-wrap items-center gap-2">
      <PopoverRoot v-model:open="rescriptOpen">
        <PopoverTrigger
          class="btn-ghost btn-xs"
          :disabled="finding || !names.some((n) => foundIn(n).length)"
          ><RetryIcon class="icon-sm" /> {{ rescriptLabel }}</PopoverTrigger
        >
        <PopoverPortal>
          <PopoverContent :side-offset="6" align="start" class="ui-popup w-80 p-3 text-xs">
            <div class="label mb-2">Re-script chapters of this book that name them</div>
            <div class="space-y-1">
              <label v-for="n in names" :key="n" class="flex items-center gap-2">
                <UiCheckbox :model-value="!dropped.has(n)" @update:model-value="tickName(n)" />
                <span class="min-w-0 flex-1 truncate">“{{ n }}”</span>
                <span class="font-mono text-zinc-400">{{
                  plural(foundIn(n).length, "ch", "ch")
                }}</span>
              </label>
            </div>
            <div class="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
              <span class="text-zinc-500">Endpoint</span><ScriptProfileSelect />
              <span class="text-zinc-500">Estimate</span>
              <span class="font-mono"
                >{{ plural(toRescript.length, "chapter")
                }}<template v-if="estimate && toRescript.length && !estimate.reading">
                  · {{ money(estimate.cost) }}</template
                ></span
              >
            </div>
            <div
              v-if="estimate?.blockers.length"
              class="mt-2 space-y-1 rounded-md bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
              role="status"
            >
              <p v-for="reason in estimate.blockers" :key="reason">{{ reason }}</p>
            </div>
            <div class="mt-3 flex justify-end gap-2">
              <button class="btn-ghost btn-xs" @click="rescriptOpen = false">Cancel</button
              ><button
                class="btn-primary btn-xs"
                :disabled="!toRescript.length || !!estimate?.blockers.length"
                @click="rescript"
              >
                Re-script {{ plural(toRescript.length, "chapter") }}
              </button>
            </div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
      <UiHint
        label="re-scripting a persona’s chapters"
        text="Chapters scripted before the link may give these lines to someone else. This scripts again the scripted chapters whose text has their name or an alias as written, at the usual cost."
      />
    </div>

    <div v-else class="space-y-1.5">
      <div class="flex items-center gap-1.5">
        <span class="label">Personas</span>
        <UiHint
          label="personas"
          :text="`Other names ${c.name} goes by in disguise. One with no voice of their own is read in ${c.name}’s; each gets ${c.name}’s effect and then their own.`"
        />
      </div>
      <div
        v-for="p in mine"
        :key="p.name"
        class="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 px-2 py-1 dark:border-zinc-800"
      >
        <MaskIcon class="icon-sm text-zinc-500" aria-hidden="true" />
        <b
          ><SpoilerText
            :text="p.name"
            :hidden="!!p.masked"
            label="found by the scripting model — spoilers · show"
            small
        /></b>
        <span v-if="p.aliases.length && !p.masked" class="text-zinc-500"
          >a.k.a. {{ p.aliases.join(", ") }}</span
        >
        <span v-if="lines(p.name) != null" class="text-zinc-400">· {{ lines(p.name) }}</span>
        <button
          class="btn-ghost btn-xs ml-auto"
          :data-tip="`Remove ${p.masked ? 'this persona' : p.name} from this book’s cast — their lines go to the Narrator`"
          @click="castStore.deleteCharacter(bookId, p.name)"
        >
          Remove
        </button>
      </div>
      <form v-if="adding" class="flex flex-wrap items-center gap-1" @submit.prevent="add">
        <input
          ref="input"
          v-model="draft"
          class="input w-48 py-0.5"
          placeholder="Name in disguise"
          :aria-label="`New persona of ${c.name}`"
          @keydown.esc="adding = false"
        />
        <button class="btn-primary btn-xs" type="submit" :disabled="taken">Add</button>
        <button class="btn-ghost btn-xs" type="button" @click="adding = false">Cancel</button>
        <span v-if="taken" class="text-[11px] text-amber-600 dark:text-amber-400"
          >already in the cast — link them from their own record</span
        >
      </form>
      <button v-else class="btn-ghost btn-xs" @click="startAdd">
        <AddIcon class="icon-sm" /> Add persona of {{ c.name }}
      </button>
    </div>
  </div>
</template>
