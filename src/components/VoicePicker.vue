<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";

// Voice picker: reka Popover + Listbox, v-model is `endpointId/voiceId` or null. Given an `anchor`
// (even null) it draws no trigger, and one picker serves a whole list: the list moves it by
// changing `anchor`, and a click on any `[data-voice-anchor]` is that move, not a click outside.
// Closing hands focus back to the anchor unless a click elsewhere took it.
import { computed, ref, watch } from "vue";

import { SAMPLE_TITLE, useVoiceSample } from "@/composables/useVoiceSample";
import { suggestVoices } from "@/lib/voiceMatch";
import { NARRATOR } from "@/lib/cast";
import SpoilerText from "@/components/SpoilerText.vue";
import type { Component } from "vue";
import {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  Dot as NeutralIcon,
  LoaderCircle as BusyIcon,
  Mars as MaleIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Sparkles as AskAiIcon,
  Venus as FemaleIcon,
} from "@lucide/vue";
import {
  ListboxContent,
  ListboxFilter,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxRoot,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
  useFilter,
} from "reka-ui";
import { UiToggleGroup } from "@/ui";
import type { Gender, VoiceRef } from "@/types";

const props = withDefaults(
  defineProps<{
    modelValue?: VoiceRef | null;
    bookId: string;
    nullLabel?: string;
    size?: "xs" | "sm";
    block?: boolean;
    speaker?: string;
    anchor?: HTMLElement | null;
  }>(),
  { modelValue: null, size: "sm", speaker: undefined },
);
const emit = defineEmits<{ "update:modelValue": [VoiceRef | null] }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const open = defineModel<boolean>("open", { default: false });
const q = ref("");
const gender = ref("all");
const { contains } = useFilter({ sensitivity: "base" });
watch(open, (o) => {
  if (o) {
    q.value = "";
    gender.value = "all";
  }
});

/** The empty choice: how this speaker is read with no voice of their own. */
const emptyLabel = computed(
  () =>
    props.nullLabel ??
    (props.speaker ? castStore.fallbackLabel(props.bookId, props.speaker) : "Narrator’s voice"),
);
const current = computed(() => endpointsStore.resolveVoice(props.modelValue));
const missing = computed(() => props.modelValue && !current.value);
const usedBy = computed(() => {
  const m: Record<VoiceRef, string[]> = {};
  for (const c of castStore.charactersOf(props.bookId))
    if (c.voice) (m[c.voice] ??= []).push(c.name);
  return m;
});
const rows = computed(() =>
  endpointsStore.endpoints
    .map((e) => ({
      endpoint: e,
      voices: e.voices.filter(
        (v) =>
          (gender.value === "all" || v.gender === gender.value) &&
          (!q.value ||
            contains(v.label, q.value) ||
            contains(v.id, q.value) ||
            contains(e.name, q.value)),
      ),
    }))
    .filter((g) => g.voices.length),
);
// Suggestions are scored only while open, for this one speaker, and only unfiltered: a search or
// gender filter means the user is looking for something else.
const character = computed(() =>
  props.speaker && props.speaker !== NARRATOR
    ? castStore.byName[props.bookId]?.get(props.speaker)
    : undefined,
);
const unfiltered = computed(() => open.value && !q.value && gender.value === "all");
const aiPicks = computed(() => {
  const c = character.value;
  if (!c || !unfiltered.value) return [];
  return (castStore.aiPicks[props.bookId]?.[c.name] ?? []).flatMap((p) => {
    const r = endpointsStore.resolveVoice(p.voice);
    return r?.endpoint.enabled ? [{ ...p, r }] : [];
  });
});
const asked = computed(
  () => !!character.value && !!castStore.aiPicks[props.bookId]?.[character.value.name],
);
const suggested = computed(() => {
  const c = character.value;
  const { voices, bands, profiled } = castStore.matchPool;
  if (!c || !unfiltered.value || !profiled) return [];
  const ai = new Set(aiPicks.value.map((p) => p.voice));
  return suggestVoices(c, voices, bands, usedBy.value)
    .filter((s) => !ai.has(s.voice))
    .map((s) => ({ ...s, r: endpointsStore.resolveVoice(s.voice)! }));
});
// the model is asked about main speakers only: a minor one is not worth the request
const canAsk = computed(() => !!character.value?.major && unfiltered.value);
const asking = ref<string | null>(null);
async function ask() {
  const name = character.value?.name;
  if (!name || asking.value || castStore.aiBlocker) return;
  asking.value = name;
  await castStore.askVoices(props.bookId, [name]);
  asking.value = null;
}
const G: Partial<Record<Gender, Component>> = { m: MaleIcon, f: FemaleIcon, n: NeutralIcon };
function pick(v: unknown) {
  const s = String(v);
  if (s === "__ask__") return void ask();
  // a suggested voice is listed twice, so its item's value is prefixed to stay unique
  emit("update:modelValue", s === "__null__" ? null : s.replace(/^(s|ai):/, ""));
  open.value = false;
}
const voiceSample = useVoiceSample();

/** focus moved outside while open, so closing must not pull it back */
let left = false;
function onOutside(e: Event) {
  if (props.anchor === undefined) return;
  if ((e.target as HTMLElement | null)?.closest?.("[data-voice-anchor]")) e.preventDefault();
  else left = true;
}
function onClosed(e: Event) {
  if (props.anchor === undefined) return;
  e.preventDefault();
  if (!left) props.anchor?.focus();
  left = false;
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      v-if="anchor === undefined"
      class="ui-select-trigger"
      :class="[
        size === 'xs' ? 'py-0.5 text-xs' : 'py-1 text-sm',
        block && 'w-full',
        !modelValue && 'italic text-zinc-400',
        missing && 'ring-1 ring-amber-400',
      ]"
    >
      <span class="min-w-0 flex-1 truncate text-left">
        <template v-if="missing"
          ><span class="not-italic text-amber-600"
            >{{ modelValue!.split("/")[1] }} — missing</span
          ></template
        >
        <template v-else-if="current"
          >{{ current.voice.label }}
          <span class="text-zinc-400">· {{ current.endpoint.name }}</span></template
        >
        <template v-else>{{ emptyLabel }}</template>
      </span>
      <ChevronDownIcon class="ml-1 icon-sm text-zinc-400" aria-hidden />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :reference="anchor ?? undefined"
        :side-offset="4"
        align="start"
        class="ui-popup w-[min(360px,92vw)]"
        @open-auto-focus.prevent
        @interact-outside="onOutside"
        @close-auto-focus="onClosed"
      >
        <ListboxRoot :model-value="undefined" highlight-on-hover @update:model-value="pick">
          <div
            class="flex items-center gap-2 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800"
          >
            <ListboxFilter
              v-model="q"
              auto-focus
              class="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
              placeholder="Search voices…"
            />
            <UiToggleGroup
              v-model="gender"
              :options="[
                { value: 'all', label: 'all' },
                { value: 'f', label: '', icon: FemaleIcon },
                { value: 'm', label: '', icon: MaleIcon },
                { value: 'n', label: '', icon: NeutralIcon },
              ]"
            />
          </div>
          <ListboxContent class="max-h-[300px] overflow-auto p-1">
            <ListboxItem value="__null__" class="ui-item italic text-zinc-500"
              >{{ emptyLabel
              }}<CheckIcon v-if="!modelValue" class="ml-auto icon-sm text-violet-500"
            /></ListboxItem>
            <ListboxGroup v-if="suggested.length || aiPicks.length || canAsk">
              <ListboxGroupLabel
                class="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"
                >Suggested</ListboxGroupLabel
              >
              <ListboxItem
                v-for="p in aiPicks"
                :key="`ai:${p.voice}`"
                :value="`ai:${p.voice}`"
                class="ui-item flex-wrap"
              >
                <AskAiIcon class="icon-sm text-violet-500" aria-label="picked by AI" />
                <span class="min-w-0 truncate">{{ p.r.voice.label }}</span>
                <span class="text-[10px] text-zinc-400">· {{ p.r.endpoint.name }}</span>
                <CheckIcon v-if="modelValue === p.voice" class="ml-auto icon-sm text-violet-500" />
                <!-- written from the speaker's description: a spoiler until asked for -->
                <span v-if="p.why" class="basis-full pl-5 text-[10px] text-zinc-500" @click.stop
                  ><SpoilerText :text="p.why" label="why · show" small
                /></span>
              </ListboxItem>
              <ListboxItem
                v-for="s in suggested"
                :key="`s:${s.voice}`"
                :value="`s:${s.voice}`"
                class="ui-item"
              >
                <component :is="G[s.r.voice.gender] ?? NeutralIcon" class="icon-sm text-zinc-400" />
                <span class="min-w-0 truncate">{{ s.r.voice.label }}</span>
                <span class="ml-2 min-w-0 truncate text-[10px] text-zinc-400">{{
                  s.reasons.join(" · ")
                }}</span>
                <CheckIcon v-if="modelValue === s.voice" class="ml-auto icon-sm text-violet-500" />
              </ListboxItem>
              <ListboxItem
                v-if="canAsk"
                value="__ask__"
                :disabled="!!asking || !!castStore.aiBlocker"
                class="ui-item text-xs text-violet-600 dark:text-violet-300"
                :data-tip="
                  castStore.aiBlocker ??
                  'The scripting model ranks your voices for this speaker from their notes and the voice profiles'
                "
              >
                <BusyIcon v-if="asking" class="icon-sm animate-spin" />
                <AskAiIcon v-else class="icon-sm" />
                {{ asking ? "Asking…" : asked ? "Ask AI again" : "Ask AI" }}
                <span v-if="asked && !aiPicks.length && !asking" class="text-[10px] text-zinc-400"
                  >· no picks last time</span
                >
              </ListboxItem>
            </ListboxGroup>
            <ListboxGroup v-for="g in rows" :key="g.endpoint.id">
              <ListboxGroupLabel
                class="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"
                ><span
                  class="h-1.5 w-1.5 rounded-full"
                  :class="g.endpoint.enabled ? 'bg-emerald-500' : 'bg-zinc-400'"
                ></span
                >{{ g.endpoint.name
                }}<span v-if="!g.endpoint.enabled" class="font-normal normal-case">· paused</span
                ><span v-if="g.endpoint.maxChars" class="font-normal normal-case"
                  >· splits over {{ g.endpoint.maxChars }}</span
                ></ListboxGroupLabel
              >
              <ListboxItem
                v-for="v in g.voices"
                :key="v.id"
                :value="`${g.endpoint.id}/${v.id}`"
                :disabled="!g.endpoint.enabled"
                class="ui-item"
              >
                <component :is="G[v.gender] ?? NeutralIcon" class="icon-sm text-zinc-400" />
                <span class="min-w-0 truncate">{{ v.label }}</span
                ><span v-if="v.label !== v.id" class="ml-1 font-mono text-[10px] text-zinc-400">{{
                  v.id
                }}</span>
                <span
                  v-if="usedBy[`${g.endpoint.id}/${v.id}`]"
                  class="ml-2 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800"
                  :data-tip="usedBy[`${g.endpoint.id}/${v.id}`].join(', ')"
                  >{{ usedBy[`${g.endpoint.id}/${v.id}`].length }} using</span
                >
                <span class="ml-auto flex items-center gap-1 pl-2">
                  <button
                    class="rounded px-1 text-zinc-400 hover:bg-zinc-200 hover:text-violet-500 dark:hover:bg-zinc-700"
                    :data-tip="SAMPLE_TITLE"
                    :aria-label="`${voiceSample.playing(`${g.endpoint.id}/${v.id}`) ? 'Pause' : 'Hear'} ${v.label}`"
                    :aria-busy="voiceSample.fetching(`${g.endpoint.id}/${v.id}`)"
                    @click.stop.prevent="voiceSample.play(g.endpoint, v.id, v.label)"
                  >
                    <BusyIcon
                      v-if="voiceSample.fetching(`${g.endpoint.id}/${v.id}`)"
                      class="icon-sm animate-spin"
                    />
                    <PauseIcon
                      v-else-if="voiceSample.playing(`${g.endpoint.id}/${v.id}`)"
                      class="icon-sm icon-fill"
                    />
                    <PlayIcon v-else class="icon-sm icon-fill" />
                  </button>
                  <CheckIcon
                    v-if="modelValue === `${g.endpoint.id}/${v.id}`"
                    class="icon-sm text-violet-500"
                  />
                </span>
              </ListboxItem>
            </ListboxGroup>
            <div v-if="!rows.length" class="p-4 text-center text-xs text-zinc-500">
              No voice matches. Voices live on the endpoint that renders them — add or fetch them on
              the Endpoints page.
            </div>
          </ListboxContent>
        </ListboxRoot>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
