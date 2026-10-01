<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";

// Voice picker for a character: a popover with search, gender filter, voices grouped by endpoint
// (paused ones listed but disabled), "used by N" and an inline demo button. Built on reka Popover +
// Listbox so arrows/Enter work. v-model is the voice ref (`endpointId/voiceId`) or null.
//
// Given an `anchor` — even a null one, before the first open — it draws no trigger of its own, and
// one picker serves a whole list, as the Cast page's: the list opens it with `v-model:open` and
// moves it to another row by changing `anchor`. A click on any `[data-voice-anchor]` button is that
// move, not a click outside. Closing hands focus back to the anchor, unless a click elsewhere took it.
import { computed, ref, watch } from "vue";

import { SAMPLE_TITLE, useVoiceSample } from "@/composables/useVoiceSample";
import type { Component } from "vue";
import {
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  Dot as NeutralIcon,
  LoaderCircle as BusyIcon,
  Mars as MaleIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
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
  { modelValue: null, nullLabel: "Narrator’s voice", size: "sm", speaker: undefined },
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
const G: Partial<Record<Gender, Component>> = { m: MaleIcon, f: FemaleIcon, n: NeutralIcon };
function pick(v: unknown) {
  emit("update:modelValue", v === "__null__" ? null : String(v));
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
        <template v-else>{{ nullLabel }}</template>
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
              >{{ nullLabel }}<CheckIcon v-if="!modelValue" class="ml-auto icon-sm text-violet-500"
            /></ListboxItem>
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
                  :title="usedBy[`${g.endpoint.id}/${v.id}`].join(', ')"
                  >{{ usedBy[`${g.endpoint.id}/${v.id}`].length }} using</span
                >
                <span class="ml-auto flex items-center gap-1 pl-2">
                  <button
                    class="rounded px-1 text-zinc-400 hover:bg-zinc-200 hover:text-violet-500 dark:hover:bg-zinc-700"
                    :title="SAMPLE_TITLE"
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
