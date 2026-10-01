<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import { useSpeakerSamplesStore, type CloneFromSamples } from "@/stores/speakerSamples";

// Cloning a voice, on a speech endpoint's Voices tab.
//
// A voice made from uploaded samples of someone speaking, kept by the provider as a private voice
// on the account and added to this endpoint like any other: the provider makes it once, and it is
// spoken by its id from then on. Only where the provider keeps one (its `cloning`): the samples go
// to the provider through the server, with the saved key, and the server keeps them beside the
// voice — so the voice can travel with a book's script to someone who has to make it again. A provider that takes a transcript of each sample is asked
// for one beside it, kept with the sample for the same reason.
//
// What a pick may be is the provider's (`cloneForm.ts`): the picker offers its formats, a pick is
// cut to the most it takes, and a file too large for it blocks the button with its name. The
// server still decides by each file's first bytes, so a renamed file is refused there with its name.
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { keyInPlace } from "@/services/endpointSettings";
import { Upload as CloneIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { UiHint } from "@/ui";
import { cloneModelsFor, cloningOf, speechProviderOf } from "@/lib/providers";
import {
  pickProblem,
  requestOf,
  transcriptsMissing,
  type SampleRow,
} from "@/views/endpoints/cloneForm";
import SamplePicker from "@/views/endpoints/SamplePicker.vue";
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
  samples: [] as SampleRow[],
  busy: false,
});
/** Why the picked samples cannot be sent, naming the file; null when nothing stops them. */
const cloneProblem = computed(() =>
  cloning.value
    ? pickProblem(
        clone.samples.map((r) => r.file),
        cloning.value,
        provider.value,
      )
    : null,
);
const cloneBlocked = computed(
  () =>
    !cloning.value ||
    !clone.title.trim() ||
    !clone.samples.length ||
    !!cloneProblem.value ||
    transcriptsMissing(clone.samples, cloning.value) ||
    clone.busy ||
    needsKeyFirst.value,
);
const about = computed(
  () =>
    `Upload clips of one person speaking and ${props.endpoint.name} makes a private voice from ` +
    "them; the clips stay on this server, so the voice can go with a book's script.",
);

// ---------- cloning from samples a script file brought ----------
// The Cast page and the import report link here with `?book=…&samples=…&speaker=…&was=…` when a
// script file carried the samples of a private voice. The form is filled with them and nothing
// more: the button is theirs to press. A voice made from them goes to the speaker only if the
// speaker's voice is still `was` — see `afterClone`.
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
  const files = await samplesStore.files(bookId, sample);
  if (!files) return;
  from.value = {
    bookId,
    sampleId,
    // the server's row, never the address: a rename since the link was made moves the row with it
    speaker: sample.speaker,
    was: query("was") || null,
    sample,
  };
  // the picker holds them to this provider like a pick by hand, since a script file may carry
  // more samples than it takes; a transcript kept with a sample comes along with it
  Object.assign(clone, {
    title: sample.title,
    samples: files.map((file, i) => ({ file, transcript: sample.samples[i]?.transcript ?? "" })),
  });
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
function reset() {
  Object.assign(clone, { title: "", samples: [] });
}
function putAside() {
  from.value = null;
  reset();
  forgetLink();
}
async function makeVoice() {
  if (cloneBlocked.value) return;
  clone.busy = true;
  try {
    const voice = await endpointsStore.cloneVoice(props.endpoint, {
      title: clone.title,
      ...requestOf(clone.samples),
    });
    if (voice) {
      if (from.value) {
        const made = from.value;
        from.value = null;
        forgetLink();
        void samplesStore.afterClone(made, `${props.endpoint.id}/${voice.id}`);
      }
      reset();
      emit("cloned");
    }
  } finally {
    clone.busy = false;
  }
}
</script>

<template>
  <section v-if="clonable && cloning" class="card p-3">
    <h3 class="label mb-1">
      <CloneIcon class="icon-sm" /> Clone a voice <UiHint label="cloning" :text="about" />
    </h3>
    <p v-if="cloning.cost" class="text-[11px] text-amber-700 dark:text-amber-300">
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
        The voice goes to {{ from.speaker }} if their voice is unchanged since the link was opened.
      </p>
    </div>
    <form class="mt-2 space-y-2" @submit.prevent="makeVoice">
      <label class="block space-y-1 text-xs font-medium"
        ><span>Name</span
        ><input
          v-model="clone.title"
          class="input block w-56"
          maxlength="100"
          placeholder="Narrator — Mara"
      /></label>
      <!-- samples picked by hand are not the ones a link brought, so the voice is not theirs -->
      <SamplePicker v-model="clone.samples" :cloning="cloning" @pick="from = null" />
      <p
        v-if="cloneProblem"
        class="rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
        role="alert"
      >
        <WarnIcon class="icon-sm" /> {{ cloneProblem }}
      </p>
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
      {{ provider }} clones only for <code>{{ cloneModels.join(", ") }}</code
      >; change this endpoint's model on the Connection tab to clone here.
    </p>
  </section>
</template>
