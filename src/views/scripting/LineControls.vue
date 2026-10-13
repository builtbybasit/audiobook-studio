<script setup lang="ts">
// In the editor of a dialogue or thought line: who it is spoken as — the character or one of their
// personas — and the line effects it is heard through. Both change only how the line sounds: a
// persona with no voice of its own speaks in its character's, so a clip needs Re-apply, not new
// speech — unless the persona has a voice or a delivery style of their own
// (`scriptsStore.retouchLines`).
import { computed, ref } from "vue";
import { VenetianMask as MaskIcon } from "@lucide/vue";
import { plural } from "@/lib/contents";
import { lineEffectsOf } from "@/lib/prompt";
import { useEffectsStore } from "@/stores/effects";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { UiHint } from "@/ui";
import { useScript } from "@/views/scripting/shared";
import { identityGroup, speakAsMoves } from "@/views/scripting/speakAs";
import type { Segment } from "@/types";

const props = defineProps<{ bookId: string; chapterId: number; segment: Segment }>();
const effectsStore = useEffectsStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const { segments, cast } = useScript(props);

// ---- speak as: the character first, then their personas
const group = computed(() => identityGroup(props.segment.speaker, cast.value));
const rest = ref(false);
function speakAs(to: string) {
  const { bookId, chapterId } = props;
  const moves = speakAsMoves(segments.value, props.segment.id, to, group.value, rest.value);
  if (!moves.length) return;
  // the script as it was, clips' freshness with it: a switch that needed new speech is undone whole
  const undo = scriptsStore._editSnapshot(bookId, chapterId);
  const respoken = scriptsStore.retouchLines(
    bookId,
    chapterId,
    moves.map((m) => ({ id: m.id, speaker: to })),
  );
  uiStore.toast(`${plural(moves.length, "line")} now spoken as ${to}`, {
    description: respoken
      ? `Another delivery style, so ${plural(respoken, "clip")} now need${respoken === 1 ? "s" : ""} new speech.`
      : "Same voice, so a clip only needs Re-apply, not new speech.",
    undo,
  });
}

// ---- line effects: every one offered to the model, and any the line has that no longer is
const on = computed(() => new Set(props.segment.effects));
const shown = computed(() => {
  const offered = new Set(lineEffectsOf(effectsStore.effects).map((e) => e.id));
  return effectsStore.effects.filter((e) => offered.has(e.id) || on.value.has(e.id));
});
function toggle(id: string) {
  const next = new Set(on.value);
  if (!next.delete(id)) next.add(id);
  // kept in the library's order, the order they run in
  const effects = effectsStore.effects.filter((e) => next.has(e.id)).map((e) => e.id);
  scriptsStore.retouchLines(props.bookId, props.chapterId, [{ id: props.segment.id, effects }]);
}
</script>

<template>
  <div
    class="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-200 pt-2 2xl:col-span-3 dark:border-zinc-800"
  >
    <div v-if="group.length > 1" class="flex flex-wrap items-center gap-1.5">
      <span class="text-zinc-400">Speak as</span>
      <div
        class="flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700"
        role="radiogroup"
        aria-label="Speak as"
      >
        <button
          v-for="(name, i) in group"
          :key="name"
          role="radio"
          :aria-checked="segment.speaker === name"
          class="flex items-center gap-1 rounded px-2 py-0.5"
          :class="
            segment.speaker === name
              ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
              : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
          "
          @click="speakAs(name)"
        >
          <MaskIcon v-if="i" class="icon-sm" aria-hidden="true" />{{ name }}
        </button>
      </div>
      <label class="flex items-center gap-1 text-zinc-500">
        <input v-model="rest" type="checkbox" class="accent-violet-500" />
        and {{ group[0] }}’s lines after it in this chapter
      </label>
      <UiHint
        label="speaking as a persona"
        text="A persona with no voice of its own speaks in its character’s, so a switch changes only the line’s effects: its clip needs Re-apply on the Cast page, not new speech — unless the persona has a voice or a delivery style of its own."
      />
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-zinc-400">Line effects</span>
      <button
        v-for="e in shown"
        :key="e.id"
        class="chip"
        :class="on.has(e.id) ? 'chip-on' : 'chip-off'"
        :aria-pressed="on.has(e.id)"
        :title="e.useWhen ? `Use when ${e.useWhen}` : 'No longer offered to the model'"
        @click="toggle(e.id)"
      >
        {{ e.name }}
      </button>
      <span v-if="!shown.length" class="text-zinc-400">none offered yet</span>
      <UiHint
        label="line effects"
        text="The scripting model puts these on lines, from the effects given a “Use when” on the Cast page. A change only needs Re-apply, not new speech."
      />
    </div>
  </div>
</template>
