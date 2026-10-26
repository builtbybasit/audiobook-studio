<script setup lang="ts">
// One voice's profile, opened from its row on the Voices tab: filled from a character page and
// its kept samples (`fillVoiceProfile`), every field editable by hand. Text fields save on change,
// so the server's trimming never fights the caret; closing blurs the focused one to save it.
import { computed, ref, watch } from "vue";
import { DialogDescription, DialogTitle } from "reka-ui";
import {
  AudioLines as SourceIcon,
  AudioWaveform as MeasureIcon,
  ExternalLink as LinkIcon,
  LoaderCircle as BusyIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Sparkles as FillIcon,
  Trash2 as ClearIcon,
  TriangleAlert as WarnIcon,
  X as CloseIcon,
} from "@lucide/vue";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptingStore } from "@/stores/scripting";
import { useUiStore } from "@/stores/ui";
import { keyInPlace } from "@/services/endpointSettings";
import { sampleId, useVoiceSample } from "@/composables/useVoiceSample";
import { AGES } from "@/lib/cast";
import { voiceRef } from "@/lib/endpoints";
import { GENDER } from "@/lib/scriptReview";
import { DELIVERIES, measuredWords, ROUGH_BELOW_SEC } from "@/lib/voiceProfile";
import { UiHint, UiSelect, UiSheet, UiSwitch } from "@/ui";
import { GENDER_ICON } from "@/views/endpoints/genders";
import WordChips from "@/views/endpoints/WordChips.vue";
import type { Age, Delivery, Endpoint, KeptVoiceSamples, VoiceProfile } from "@/types";

const props = defineProps<{
  endpoint: Endpoint;
  voiceId: string | null;
  kept?: KeptVoiceSamples;
}>();
const open = defineModel<boolean>("open", { default: false });
const endpointsStore = useEndpointsStore();
const scriptingStore = useScriptingStore();
const uiStore = useUiStore();

const voice = computed(() => props.endpoint.voices.find((v) => v.id === props.voiceId));
const profile = computed<VoiceProfile>(() => voice.value?.profile ?? {});
const known = computed(() => Object.keys(profile.value).length > 0);
const notes = computed(() =>
  props.voiceId
    ? (endpointsStore.profileNotes[voiceRef(props.endpoint.id, props.voiceId)] ?? [])
    : [],
);
const set = (patch: Partial<VoiceProfile>) =>
  props.voiceId && endpointsStore.setVoiceProfile(props.endpoint.id, props.voiceId, patch);
const text = (e: Event) => (e.target as HTMLInputElement).value.trim();

const url = ref("");
const byHand = ref(false);
watch(
  () => props.voiceId,
  () => {
    url.value = profile.value.source?.url ?? "";
    byHand.value = false;
  },
  { immediate: true },
);
watch(
  open,
  (o) => {
    if (!o) (document.activeElement as HTMLElement | null)?.blur?.();
  },
  { flush: "sync" },
);

// ---------- filling ----------
const asker = computed(() =>
  scriptingStore.runBlockers.length ? undefined : scriptingStore.runProfile,
);
const askerProblem = computed(() =>
  asker.value
    ? ""
    : endpointsStore.profiles.length
      ? scriptingStore.runBlockers[0]
      : "Add a scripting endpoint to fill a profile from a page.",
);
const urlOk = computed(() => /^https?:\/\/[^\s/]+\.[^\s]+$/.test(url.value.trim()));
const busy = ref<"fill" | "measure" | null>(null);
const fillTip = computed(() =>
  !urlOk.value
    ? "Paste the character's page first"
    : asker.value
      ? `Asks ${asker.value.name}: one priced request`
      : askerProblem.value,
);
const measureTip = computed(() =>
  props.kept
    ? "Free · pitch, clarity and intonation from the samples it was made from"
    : "This voice has no kept samples to measure",
);
async function fill(ai: boolean) {
  const v = voice.value;
  if (!v || busy.value || (ai && (!urlOk.value || !asker.value)) || (!ai && !props.kept)) return;
  busy.value = ai ? "fill" : "measure";
  try {
    await uiStore.toastLoading(
      endpointsStore.fillVoiceProfile(props.endpoint.id, v.id, {
        ai,
        ...(ai ? { url: url.value.trim() } : {}),
      }),
      {
        loading: ai ? `Reading the page and asking ${asker.value!.name}…` : `Measuring ${v.label}…`,
        success: (f) =>
          ai
            ? `Filled the profile of ${v.label}`
            : f.profile.measured
              ? `Measured ${v.label}`
              : `${v.label} could not be measured`,
        error: `Could not ${ai ? "fill" : "measure"} ${v.label}`,
      },
    );
  } catch {
    // said by the toast
  } finally {
    busy.value = null;
  }
}

// ---------- measured ----------
const words = computed(() => {
  const m = profile.value.measured;
  return m && voice.value && measuredWords(m, voice.value.gender, endpointsStore.voiceBands);
});
// a male voice measured this high (or a female one this low) is more likely tagged wrong
const genderFix = computed(() => {
  const m = profile.value.measured;
  if (!m || !voice.value) return null;
  if (voice.value.gender === "m" && m.f0 > 175) return "f" as const;
  if (voice.value.gender === "f" && m.f0 < 150) return "m" as const;
  return null;
});

// ---------- fields ----------
const AGE_OPTIONS = AGES.map((a) => ({ value: a, label: a }));
const MAX_DELIVERY = 3;
const delivery = computed(() => profile.value.delivery ?? []);
function toggle(d: Delivery) {
  const cur = delivery.value;
  if (cur.includes(d)) set({ delivery: cur.filter((x) => x !== d) });
  else if (cur.length < MAX_DELIVERY) set({ delivery: [...cur, d] });
}
const narrator = computed(() => profile.value.narrator ?? { fit: false, why: "" });

// ---------- hearing it ----------
const { loading: sampling, play, playUrl, playingId } = useVoiceSample();
const needsKeyFirst = computed(() => props.endpoint.needsKey && !keyInPlace(props.endpoint));
const sourceId = computed(() => `source:${props.endpoint.id}/${props.voiceId}`);
async function playSource() {
  const v = voice.value;
  const url = props.kept && (await endpointsStore.sourceRecording(props.endpoint, props.kept));
  if (v && url) await playUrl(sourceId.value, url, `${v.label} · recording`);
}
const lineId = computed(
  () => `${sampleId(props.endpoint.id, props.voiceId ?? "")}#own:${profile.value.previewLine}`,
);
function hearLine() {
  const v = voice.value;
  const line = profile.value.previewLine;
  if (v && line) void play(props.endpoint, v.id, v.label, lineId.value, line);
}

const sourceSaid = computed(() => {
  const s = profile.value.source;
  if (!s) return "";
  let host = s.url;
  try {
    host = new URL(s.url).hostname.replace(/^www\./, "");
  } catch {
    // shown as given
  }
  const at = new Date(s.at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${host} · ${at}`;
});
</script>

<template>
  <UiSheet v-model:open="open" class="max-w-[480px]">
    <template v-if="voice">
      <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <component :is="GENDER_ICON[voice.gender]" class="icon shrink-0 text-zinc-400" />
        <DialogTitle class="truncate font-semibold">{{ voice.label }}</DialogTitle>
        <DialogDescription as="span" class="text-xs text-zinc-400">{{
          GENDER[voice.gender] ?? "unknown"
        }}</DialogDescription>
        <button
          v-if="kept"
          class="btn-ghost btn-xs"
          data-tip="The recording this voice was made from"
          :aria-label="`${playingId(sourceId) ? 'Pause' : 'Play'} the recording ${voice.label} was made from`"
          :disabled="!!sampling && sampling !== sourceId"
          @click="playSource"
        >
          <PauseIcon v-if="playingId(sourceId)" class="icon-sm icon-fill" />
          <SourceIcon v-else class="icon-sm" />
        </button>
        <button
          class="ml-auto rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          aria-label="Close"
          @click="open = false"
        >
          <CloseIcon class="icon" />
        </button>
      </div>

      <div class="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <!-- filling -->
        <section class="space-y-2">
          <p v-if="!known" class="text-xs text-zinc-500">
            Nothing is known about {{ voice.label }} yet.
          </p>
          <form class="flex items-center gap-2" @submit.prevent="fill(true)">
            <input
              v-model="url"
              type="url"
              class="input min-w-0 flex-1"
              placeholder="Fandom or wiki page"
              aria-label="The character's page"
              spellcheck="false"
            />
            <button
              type="submit"
              class="btn-primary btn-xs shrink-0"
              :disabled="!urlOk || !asker || !!busy"
              :data-tip="fillTip"
              :aria-busy="busy === 'fill'"
            >
              <BusyIcon v-if="busy === 'fill'" class="icon-sm animate-spin" />
              <FillIcon v-else class="icon-sm" />
              Fill from page
            </button>
            <UiHint
              label="filling from a page"
              text="Reads the character's page and asks the scripting endpoint to describe the voice, measuring its kept samples too. Only blank fields are filled: what you typed stays."
            />
          </form>
          <p v-if="askerProblem" class="text-[11px] text-amber-600 dark:text-amber-400">
            {{ askerProblem }}
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <button
              class="btn-ghost btn-xs"
              :disabled="!kept || !!busy"
              :data-tip="measureTip"
              :aria-busy="busy === 'measure'"
              @click="fill(false)"
            >
              <BusyIcon v-if="busy === 'measure'" class="icon-sm animate-spin" />
              <MeasureIcon v-else class="icon-sm" />
              Measure samples
            </button>
            <button v-if="!known && !byHand" class="btn-ghost btn-xs" @click="byHand = true">
              Describe by hand
            </button>
            <a
              v-if="profile.source"
              :href="profile.source.url"
              target="_blank"
              rel="noopener noreferrer"
              class="ml-auto inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-violet-500"
              :data-tip="profile.source.url"
              ><LinkIcon class="icon-sm" /> {{ sourceSaid }}</a
            >
          </div>
          <p v-for="n in notes" :key="n" class="text-[11px] text-zinc-500">{{ n }}</p>
        </section>

        <template v-if="known || byHand">
          <!-- measured -->
          <section v-if="profile.measured && words" class="space-y-1.5">
            <div class="label">
              Sounds
              <UiHint
                label="measured words"
                text="Measured from the kept samples, against the other voices of this gender in your library."
              />
            </div>
            <div class="flex flex-wrap items-center gap-1">
              <span v-if="words.pitch" class="chip">{{ words.pitch }} pitch</span>
              <span v-if="words.texture" class="chip">{{ words.texture }}</span>
              <span class="chip">{{ words.intonation }}</span>
              <span
                v-if="words.rough"
                class="text-[11px] text-amber-600 dark:text-amber-400"
                :data-tip="`Under ${ROUGH_BELOW_SEC} s of voiced speech was measured: keep longer samples for steadier words`"
                >rough — under {{ ROUGH_BELOW_SEC }} s of speech</span
              >
            </div>
            <p class="font-mono text-[10px] text-zinc-400">
              {{ Math.round(profile.measured.f0) }} Hz · HNR
              {{ profile.measured.hnr.toFixed(1) }} dB · range
              {{ profile.measured.rangeSt.toFixed(1) }} st ·
              {{ Math.round(profile.measured.voicedSec) }} s
            </p>
            <div
              v-if="genderFix"
              class="flex items-center gap-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
              role="alert"
            >
              <WarnIcon class="icon-sm shrink-0" />
              <span class="flex-1"
                >Pitched like a {{ GENDER[genderFix] }} voice, but tagged
                {{ GENDER[voice.gender] }}.</span
              >
              <button class="btn-ghost btn-xs" @click="voice.gender = genderFix">
                Set to {{ GENDER[genderFix] }}
              </button>
            </div>
          </section>

          <!-- fields -->
          <section class="space-y-3">
            <div class="space-y-1">
              <div class="label">
                Age
                <UiHint
                  label="the voice's age"
                  text="How old the voice sounds, not the character's age in its story."
                />
              </div>
              <UiSelect
                :model-value="profile.age ?? null"
                :options="AGE_OPTIONS"
                null-value="unknown"
                size="xs"
                class="w-40"
                aria-label="How old the voice sounds"
                @update:model-value="(a) => set({ age: (a as Age | null) ?? undefined })"
              />
            </div>

            <div class="space-y-1">
              <div class="label">
                Delivery
                <UiHint
                  label="delivery"
                  text="Up to three words for how it speaks. Cast notes describe speakers with the same words, so voices can be matched to them."
                />
              </div>
              <div class="flex flex-wrap gap-1" role="group" aria-label="Delivery">
                <button
                  v-for="d in DELIVERIES"
                  :key="d"
                  type="button"
                  class="chip"
                  :class="[
                    delivery.includes(d) && 'chip-on',
                    !delivery.includes(d) && delivery.length >= MAX_DELIVERY && 'opacity-40',
                  ]"
                  :aria-pressed="delivery.includes(d)"
                  :data-tip="
                    !delivery.includes(d) && delivery.length >= MAX_DELIVERY
                      ? 'Three at most: take one off first'
                      : undefined
                  "
                  @click="toggle(d)"
                >
                  {{ d }}
                </button>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-1">
                <div class="label">
                  Suits
                  <UiHint label="suits" text="Kinds of character it fits, a few words each." />
                </div>
                <WordChips
                  :model-value="profile.suits"
                  label="Kinds of character it suits"
                  placeholder="gruff mentor ⏎"
                  @update:model-value="(w) => set({ suits: w })"
                />
              </div>
              <div class="space-y-1">
                <div class="label">
                  Avoid
                  <UiHint label="avoid" text="Kinds of character it does badly." />
                </div>
                <WordChips
                  :model-value="profile.avoid"
                  label="Kinds of character to avoid"
                  placeholder="small child ⏎"
                  @update:model-value="(w) => set({ avoid: w })"
                />
              </div>
            </div>

            <div class="space-y-1">
              <div class="label">
                Summary <UiHint label="the summary" text="One line on how it sounds." />
              </div>
              <input
                class="input w-full"
                maxlength="300"
                :value="profile.summary ?? ''"
                aria-label="Summary"
                @change="set({ summary: text($event) })"
              />
            </div>

            <div class="space-y-1">
              <div class="label">
                Preview line
                <UiHint
                  label="the preview line"
                  text="An in-character line to hear the voice by. Play says it in this voice: a real request, billed once and kept."
                />
              </div>
              <div class="flex items-center gap-2">
                <input
                  class="input min-w-0 flex-1"
                  maxlength="500"
                  :value="profile.previewLine ?? ''"
                  aria-label="Preview line"
                  @change="set({ previewLine: text($event) })"
                />
                <button
                  class="btn-ghost btn-xs shrink-0"
                  :aria-label="`${playingId(lineId) ? 'Pause' : 'Hear'} ${voice.label} say the preview line`"
                  :data-tip="
                    needsKeyFirst
                      ? 'Save a key for this endpoint first: a sample is a real request'
                      : !profile.previewLine
                        ? 'Write a line first'
                        : 'Hear this voice say it: a real request, billed once and kept'
                  "
                  :disabled="
                    needsKeyFirst || !profile.previewLine || (!!sampling && sampling !== lineId)
                  "
                  :aria-busy="sampling === lineId"
                  @click="hearLine"
                >
                  <BusyIcon v-if="sampling === lineId" class="icon-sm animate-spin" />
                  <PauseIcon v-else-if="playingId(lineId)" class="icon-sm icon-fill" />
                  <PlayIcon v-else class="icon-sm icon-fill" />
                </button>
              </div>
            </div>

            <div class="space-y-1">
              <div class="label">
                Narrator
                <UiHint
                  label="narrator fit"
                  text="Whether it could carry a whole book as Narrator, and why."
                />
              </div>
              <div class="flex items-center gap-3">
                <UiSwitch
                  :model-value="narrator.fit"
                  label="Could narrate"
                  @update:model-value="(fit) => set({ narrator: { ...narrator, fit } })"
                />
                <input
                  class="input min-w-0 flex-1"
                  maxlength="300"
                  placeholder="why"
                  :value="narrator.why"
                  aria-label="Why it could or could not narrate"
                  @change="set({ narrator: { ...narrator, why: text($event) } })"
                />
              </div>
            </div>

            <div class="space-y-1">
              <div class="label">
                Style
                <UiHint
                  label="the style"
                  text="A delivery note offered to a speaker given this voice."
                />
              </div>
              <input
                class="input w-full"
                maxlength="300"
                :value="profile.style ?? ''"
                aria-label="Style"
                @change="set({ style: text($event) })"
              />
            </div>
          </section>
        </template>
      </div>

      <div
        v-if="known"
        class="flex justify-end border-t border-zinc-200 px-4 py-2 dark:border-zinc-800"
      >
        <button
          class="btn-ghost btn-xs hover:text-red-500"
          data-tip="Forget everything above; undoable from the toast"
          @click="endpointsStore.clearVoiceProfile(endpoint.id, voice.id)"
        >
          <ClearIcon class="icon-sm" /> Clear profile
        </button>
      </div>
    </template>
  </UiSheet>
</template>
