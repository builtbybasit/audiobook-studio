<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import { useSpeakerSamplesStore, type CloneFromSamples } from "@/stores/speakerSamples";

// Cloning a voice on a speech endpoint's Voices tab, where the provider supports it (`cloning`).
// The server keeps the samples (and transcripts) beside the voice, so it can travel with a book's
// script to someone who must make it again. Pick limits: `cloneForm.ts`.
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { keyInPlace } from "@/services/endpointSettings";
import {
  LoaderCircle as BusyIcon,
  Upload as CloneIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import { UiHint } from "@/ui";
import { cloneModelsFor, cloningOf, speechProviderOf } from "@/lib/providers";
import {
  pickProblem,
  requestOf,
  transcriptsMissing,
  type SampleRow,
} from "@/views/endpoints/cloneForm";
import SamplePicker from "@/views/endpoints/SamplePicker.vue";
import type { Endpoint, SpeakerSamples, Voice } from "@/types";

const props = defineProps<{ endpoint: Endpoint }>();
const emit = defineEmits<{ cloned: []; profile: [voiceId: string] }>();
const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
const samplesStore = useSpeakerSamplesStore();
const route = useRoute();
const router = useRouter();

const needsKeyFirst = computed(() => props.endpoint.needsKey && !keyInPlace(props.endpoint));
const cloning = computed(() => cloningOf(props.endpoint));
const provider = computed(() => speechProviderOf(props.endpoint).label);
const clonable = computed(() => !!cloning.value);
// a provider that clones only on some models (Qwen) names them
const cloneModels = computed(() => cloneModelsFor(props.endpoint));
const clone = reactive({
  title: "",
  samples: [] as SampleRow[],
  /** a character page to describe the voice from */
  page: "",
  busy: false,
});
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
// Linked with `?book=…&samples=…&speaker=…&was=…`; only fills the form. The voice goes to the
// speaker only if their voice is still `was` (see `afterClone`).
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
    // from the server's row, not the address, so a rename since the link still matches
    speaker: sample.speaker,
    was: query("was") || null,
    sample,
  };
  // held to this provider's limits like a hand pick: a script file may carry more than it takes
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
/** Empties the form and drops the link from the address. */
function forgetLink() {
  const { book: _b, samples: _s, speaker: _p, was: _w, ...rest } = route.query;
  void router.replace({ query: rest });
}
function reset() {
  Object.assign(clone, { title: "", samples: [], page: "" });
}

// ---------- describing the new voice ----------
// Its samples are always measured; the page is read only when one was given.
const describing = ref<string | null>(null);
async function describe(voice: Voice, page: string) {
  const open = { label: "Open profile", run: () => emit("profile", voice.id) };
  describing.value = voice.label;
  try {
    const fill = await endpointsStore.fillVoiceProfile(props.endpoint.id, voice.id, {
      ai: !!page,
      ...(page ? { url: page } : {}),
    });
    const got = Object.keys(fill.profile).length > 0;
    uiStore.toast(got ? `Described ${voice.label}` : `${voice.label} has no profile yet`, {
      kind: got && !fill.notes.length ? "success" : "warn",
      description: fill.notes.join(" "),
      action: open,
    });
  } catch (cause) {
    uiStore.toast(`Could not describe ${voice.label}`, {
      kind: "warn",
      description: cause instanceof Error ? cause.message : String(cause),
      action: open,
    });
  } finally {
    describing.value = null;
  }
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
      void describe(voice, clone.page.trim());
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
      <div class="space-y-1 text-xs font-medium">
        <span
          >Wiki page
          <UiHint
            label="the wiki page"
            text="Reads the character's page to describe the voice. Optional."
        /></span>
        <input
          v-model="clone.page"
          type="url"
          class="input block w-full max-w-md"
          placeholder="Fandom or wiki page"
          aria-label="Wiki page"
          spellcheck="false"
        />
      </div>
      <!-- a hand pick detaches the voice from the linked speaker -->
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
        <span
          v-if="describing"
          class="flex items-center gap-1 text-[11px] text-zinc-500"
          role="status"
          ><BusyIcon class="icon-sm animate-spin" /> Describing {{ describing }}…</span
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
