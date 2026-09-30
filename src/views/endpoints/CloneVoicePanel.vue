<script setup lang="ts">
import { sizeLabel } from "@/lib/audioFormat";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import { useSpeakerSamplesStore, type CloneFromSamples } from "@/stores/speakerSamples";

// Cloning a voice, on a speech endpoint's Voices tab.
//
// A voice made from samples of someone speaking — recorded, or downloaded — kept by the provider as
// a private voice on the account and added to this endpoint like any other: the provider makes it
// once, and it is spoken by its id from then on. Only where the provider keeps one (its `cloning`):
// the samples go to the provider through the server, with the saved key, and the server keeps them
// beside the voice with the consent they were given under — so the voice can travel with a book's
// script to someone who has to make it again.
//
// What a pick may be is the provider's (`cloneForm.ts`): the picker offers its formats, a pick is
// cut to the most it takes, and a file too large for it blocks the button with its name. The
// server still decides by each file's first bytes, so a renamed file is refused there with its name.
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { keyInPlace } from "@/services/endpointSettings";
import { Mic as CloneIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { UiCheckbox } from "@/ui";
import { plural } from "@/lib/contents";
import { CLONE_CONSENT } from "@/lib/endpointShapes";
import { cloneModelsFor, cloningOf, speechProviderOf } from "@/lib/providers";
import { maxSamplesOf } from "@/lib/voiceSamples";
import {
  acceptOf,
  leftOutSaid,
  limitsSaid,
  pickOf,
  pickProblem,
} from "@/views/endpoints/cloneForm";
import type { Endpoint, SpeakerSamples } from "@/types";

const props = defineProps<{ endpoint: Endpoint }>();
/** A voice was made and added to the endpoint, with its samples kept on the server. */
const emit = defineEmits<{ cloned: [] }>();
const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
const samplesStore = useSpeakerSamplesStore();
const route = useRoute();
const router = useRouter();

const needsKeyFirst = computed(() => props.endpoint.needsKey && !keyInPlace(props.endpoint));
const cloning = computed(() => cloningOf(props.endpoint));
const provider = computed(() => speechProviderOf(props.endpoint).label);
const clonable = computed(() => !!cloning.value);
// a provider that clones only for some of its models (Qwen) says which, where this one does not
const cloneModels = computed(() => cloneModelsFor(props.endpoint));
const clone = reactive({
  title: "",
  samples: [] as File[],
  /** how many picked samples were left out, past the most one voice is made from */
  leftOut: 0,
  consent: false,
  busy: false,
});
const samplesInput = ref<HTMLInputElement | null>(null);
const samplesSize = computed(() => clone.samples.reduce((n, f) => n + f.size, 0));
/** Why the picked samples cannot be sent, naming the file; null when nothing stops them. */
const cloneProblem = computed(() =>
  cloning.value ? pickProblem(clone.samples, cloning.value, provider.value) : null,
);
const cloneBlocked = computed(
  () =>
    !clone.title.trim() ||
    !clone.samples.length ||
    !!cloneProblem.value ||
    !clone.consent ||
    clone.busy ||
    needsKeyFirst.value,
);
/** Samples held to this provider: up to the most one voice is made from, and how many were not. */
const heldTo = (samples: File[]) =>
  cloning.value ? pickOf(samples, cloning.value) : { samples: [], leftOut: samples.length };
function pickSamples(e: Event) {
  Object.assign(clone, heldTo([...((e.target as HTMLInputElement).files ?? [])]));
  // samples picked by hand are not the ones the link brought, so the voice is not theirs to assign
  from.value = null;
}

// ---------- cloning from samples a script file brought ----------
// The Cast page and the import report link here with `?book=…&samples=…&speaker=…&was=…` when a
// script file carried the samples of a private voice. The form is filled with them and nothing
// more: the file's consent record is shown as what someone else agreed to, the box stays unticked
// for this person's own, and the button is theirs to press. A voice made from them goes to the
// speaker only if the speaker's voice is still `was` — see `afterClone`.
const from = ref<(CloneFromSamples & { sample: SpeakerSamples }) | null>(null);
const query = (k: string): string => {
  const v = route.query[k];
  return typeof v === "string" ? v : "";
};
async function prefill() {
  const bookId = query("book");
  const sampleId = Number(query("samples"));
  if (query("endpoint") !== `tts:${props.endpoint.id}` || !bookId || !sampleId || !clonable.value)
    return;
  if (from.value?.bookId === bookId && from.value.sampleId === sampleId) return;
  const sample = (await samplesStore.load(bookId)).find((x) => x.id === sampleId);
  if (!sample) {
    uiStore.toast("Those voice samples are no longer waiting", {
      kind: "info",
      description: "They were cloned or discarded after the link was made.",
    });
    return;
  }
  const samples = await samplesStore.files(bookId, sample);
  if (!samples) return;
  from.value = {
    bookId,
    sampleId,
    // the server's row, never the address: a rename since the link was made moves the row with it
    speaker: sample.speaker,
    was: query("was") || null,
    sample,
  };
  // held to this provider like a pick by hand: a script file may carry more samples than it takes
  Object.assign(clone, { title: sample.title, ...heldTo(samples), consent: false });
  if (samplesInput.value) samplesInput.value.value = "";
}
watch(
  () => [route.query.book, route.query.samples, props.endpoint.id, clonable.value],
  () => void prefill(),
  { immediate: true },
);
/** Leave the link behind: the form empties, and the address stops asking for it again. */
function forgetLink() {
  const { book: _b, samples: _s, speaker: _p, was: _w, ...rest } = route.query;
  void router.replace({ query: rest });
}
function putAside() {
  from.value = null;
  Object.assign(clone, { title: "", samples: [], leftOut: 0, consent: false });
  forgetLink();
}
async function makeVoice() {
  if (cloneBlocked.value) return;
  clone.busy = true;
  try {
    const voice = await endpointsStore.cloneVoice(props.endpoint, {
      title: clone.title,
      samples: clone.samples,
      consent: clone.consent,
    });
    if (voice) {
      if (from.value) {
        const made = from.value;
        from.value = null;
        forgetLink();
        void samplesStore.afterClone(made, `${props.endpoint.id}/${voice.id}`);
      }
      clone.title = "";
      clone.samples = [];
      clone.leftOut = 0;
      clone.consent = false;
      if (samplesInput.value) samplesInput.value.value = "";
      emit("cloned");
    }
  } finally {
    clone.busy = false;
  }
}
</script>

<template>
  <section v-if="clonable && cloning" class="card p-3">
    <h3 class="label mb-1"><CloneIcon class="icon-sm" /> Clone a voice</h3>
    <p class="text-[11px] leading-relaxed text-zinc-500">
      Make a voice from samples of one person speaking — audio you recorded or downloaded, any clip
      of that one voice you have the right to use. {{ endpoint.name }} makes the voice once and
      keeps it as a private voice on your account; it is added to this list, and spoken by its id
      from then on. The samples are kept on this server with the voice and your consent, so the
      voice can go with a book's script.
    </p>
    <p class="mt-1 text-[11px] leading-relaxed text-zinc-500">
      {{ cloning.advice }} {{ limitsSaid(cloning) }}
    </p>
    <p
      v-if="cloning.cost"
      class="mt-1 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
    >
      {{ cloning.cost }}
    </p>
    <div
      v-if="from"
      class="mt-2 rounded border border-violet-200 bg-violet-50 px-2.5 py-2 text-[11px] leading-relaxed dark:border-violet-500/30 dark:bg-violet-500/10"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-medium"
          >Samples for {{ from.speaker }}, from {{ from.sample.source }}</span
        >
        <button type="button" class="btn-ghost btn-xs" @click="putAside">Put them aside</button>
      </div>
      <p class="text-zinc-600 dark:text-zinc-400">
        Consent recorded {{ new Date(from.sample.consentAt).toLocaleDateString() }}: “{{
          from.sample.consentText
        }}” That is someone else's record, not yours — tick the box below only if it holds for you
        too. A voice made here goes to {{ from.speaker }} if their voice has not changed since the
        link was opened.
      </p>
    </div>
    <form class="mt-2 space-y-2" @submit.prevent="makeVoice">
      <div class="flex flex-wrap items-end gap-2">
        <label class="space-y-1 text-xs font-medium"
          ><span>Name</span
          ><input
            v-model="clone.title"
            class="input w-56"
            maxlength="100"
            placeholder="Narrator — Mara"
        /></label>
        <label class="space-y-1 text-xs font-medium"
          ><span>{{ maxSamplesOf(cloning) === 1 ? "Sample" : "Samples" }}</span
          ><input
            ref="samplesInput"
            type="file"
            :accept="acceptOf(cloning)"
            :multiple="maxSamplesOf(cloning) > 1"
            class="block text-xs"
            @change="pickSamples"
        /></label>
        <span v-if="clone.samples.length" class="text-[11px] text-zinc-500">
          {{ plural(clone.samples.length, "sample") }}, {{ sizeLabel(samplesSize) }}
        </span>
        <span v-if="clone.leftOut" class="text-[11px] text-amber-600 dark:text-amber-400">
          {{ leftOutSaid(clone.leftOut, cloning) }}
        </span>
      </div>
      <p
        v-if="cloneProblem"
        class="rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
        role="alert"
      >
        <WarnIcon class="icon-sm" /> {{ cloneProblem }}
      </p>
      <label class="flex items-start gap-2 text-xs">
        <UiCheckbox v-model="clone.consent" />
        <span>{{ CLONE_CONSENT }}</span>
      </label>
      <div class="flex items-center gap-2">
        <button class="btn-primary btn-xs" type="submit" :disabled="cloneBlocked">
          <CloneIcon class="icon-sm" /> {{ clone.busy ? "Making the voice…" : "Make voice" }}
        </button>
        <span v-if="needsKeyFirst" class="text-[11px] text-amber-600 dark:text-amber-400"
          >Save a key for this endpoint first.</span
        >
      </div>
    </form>
  </section>
  <section v-else-if="cloneModels.length" class="card p-3">
    <h3 class="label mb-1"><CloneIcon class="icon-sm" /> Clone a voice</h3>
    <p class="text-[11px] leading-relaxed text-zinc-500">
      {{ provider }} makes a voice from a sample only for <code>{{ cloneModels.join(", ") }}</code
      >, and the voice then speaks only with that model. Change this endpoint's model on the
      Connection tab to clone one here.
    </p>
  </section>
</template>
