<script setup lang="ts">
// One speaker's full record, opened under a Cast table row: every field but the voice.
import { computed, ref, useId } from "vue";

import { useCastStore, wikiSkip } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useEndpointsStore } from "@/stores/endpoints";
import { useSpeakerSamplesStore } from "@/stores/speakerSamples";
import { plural } from "@/lib/contents";
import { sizeLabel } from "@/lib/audioFormat";
import { GENDER } from "@/lib/scriptReview";
import { UiHint, UiSelect, UiSwitch } from "@/ui";
import SpoilerText from "@/components/SpoilerText.vue";
import PersonaSection from "@/views/cast/persona/PersonaSection.vue";
import SpeakerProfile from "@/views/cast/SpeakerProfile.vue";
import { BookOpenText as WikiIcon, Plus as AddIcon, X as CloseIcon } from "@lucide/vue";
import { fillChips, webAddress } from "@/views/cast/wiki";
import { AGES, describe } from "@/lib/cast";
import { nameSaid } from "@/lib/speech";
import { DELIVERIES, PITCHES, TEXTURES } from "@/lib/voiceProfile";
import type {
  Age,
  Character,
  Delivery,
  Gender,
  Pitch,
  SpeakerWikiFill,
  Texture,
  VoiceType,
} from "@/types";

const props = defineProps<{
  bookId: string;
  c: Character;
  /** a speaker's lines in words ("12 lines", "some lines"), or null until counted */
  lines: (name: string) => string | null;
}>();

const castStore = useCastStore();
const libraryStore = useLibraryStore();
const endpointsStore = useEndpointsStore();
const samplesStore = useSpeakerSamplesStore();
const bookId = props.bookId;

const GENDERS = (["f", "m", "n", "?"] as Gender[]).map((value) => ({
  value,
  label: GENDER[value] ?? "unknown",
}));
const AGE_OPTIONS = [
  ...AGES.map((value) => ({ value, label: value })),
  { value: "?", label: "unknown" },
];

const unknownOr = (words: readonly string[]) => [
  ...words.map((value) => ({ value, label: value })),
  { value: "?", label: "unknown" },
];
const PITCH_OPTIONS = unknownOr(PITCHES);
const TEXTURE_OPTIONS = unknownOr(TEXTURES);
/** Merge into their voice type; a field set to unknown is dropped, and an empty type with it. */
function setVoiceType(patch: VoiceType) {
  const next: VoiceType = { ...props.c.voiceType, ...patch };
  if (!next.pitch) delete next.pitch;
  if (!next.texture) delete next.texture;
  if (!next.delivery?.length) delete next.delivery;
  void castStore.updateCharacter(bookId, props.c.name, {
    voiceType: Object.keys(next).length ? next : undefined,
  });
}
const delivery = computed(() => props.c.voiceType?.delivery ?? []);
function toggleDelivery(d: Delivery) {
  const on = delivery.value.includes(d);
  setVoiceType({ delivery: on ? delivery.value.filter((x) => x !== d) : [...delivery.value, d] });
}
// offered, never applied on its own: a style change marks their finished lines as changed
const voiceStyle = computed(() => {
  const style = endpointsStore.resolveVoice(props.c.voice)?.voice.profile?.style?.trim();
  return style && style !== props.c.style.trim() ? style : undefined;
});

// The profile and facts are written from the whole book, so they hide behind a button (no
// spoilers); a speaker with nothing to tell when the record opened stays shown while typed in.
const hides = props.c.name !== "Narrator" && !!describe(props.c);
// the labels sit beside a "?" rather than around the field, so they point at it by id
const nameId = useId();
const styleId = useId();

// Voice samples an imported script brought for a voice this install can't reach.
/** A speaker's waiting samples as a list of none or one, for the template to loop over. */
const waiting = (name: string) => {
  const w = samplesStore.waitingFor(bookId, name);
  return w ? [w] : [];
};

// shown while switched on, before anything is typed; after, the entries say it is on
const said = computed(() => nameSaid(castStore.lexiconOf(bookId), props.c.name));
const saying = ref(false);
const saysOn = computed(() => saying.value || said.value != null);
const words = (s: string) => s.trim().split(/\s+/).length;
const uneven = computed(() => said.value != null && words(said.value) !== words(props.c.name));
function switchSays(on: boolean) {
  saying.value = on;
  if (!on) castStore.sayName(bookId, props.c.name, null);
}

// One speaker's wiki page: read, previewed as chips, applied only when asked.
const bookWiki = computed(() => libraryStore.bookById(bookId)?.wiki);
const wikiHost = computed(() => {
  try {
    return bookWiki.value && new URL(bookWiki.value).host;
  } catch {
    return undefined;
  }
});
const pageUrl = ref("");
const badPage = computed(() => !!pageUrl.value.trim() && !webAddress(pageUrl.value));
const reading = ref(false);
const found = ref<SpeakerWikiFill | null>(null);
const foundChips = computed(() => (found.value ? fillChips(props.c, found.value.fill) : []));
const fillWhy = computed(
  () =>
    wikiSkip(props.c) ??
    castStore.aiBlocker ??
    (badPage.value
      ? "Not a web address: start it with https://"
      : !pageUrl.value.trim() && !bookWiki.value
        ? "Paste their page’s address, or set the book’s wiki with Fill from wiki…"
        : undefined),
);
async function readPage() {
  reading.value = true;
  found.value = null;
  const [row] = await castStore.wikiFills(bookId, [props.c.name], {
    url: pageUrl.value.trim() || undefined,
  });
  found.value = row ?? null;
  reading.value = false;
}
function applyPage() {
  if (found.value) castStore.applyWikiFills(bookId, [found.value]);
  found.value = null;
}

const alias = ref("");
function addAlias(c: Character) {
  if (castStore.addAlias(bookId, c.name, alias.value)) alias.value = "";
}
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-2">
    <div class="space-y-2.5">
      <div class="space-y-1 text-xs font-medium">
        <div class="flex items-center gap-1">
          <label :for="nameId">Name</label>
          <UiHint
            label="renaming"
            text="Renaming re-points every line; typing an existing speaker’s name merges into them."
          />
        </div>
        <input
          :value="c.name"
          class="input w-full"
          :id="nameId"
          @change="
            castStore.renameCharacter(bookId, c.name, ($event.target as HTMLInputElement).value)
          "
        />
      </div>
      <div v-if="c.name !== 'Narrator'" class="space-y-1 text-xs font-medium">
        <div class="flex items-center gap-1">
          <label class="flex items-center gap-2"
            ><UiSwitch :model-value="saysOn" @update:model-value="switchSays" /> Read aloud as
            another name</label
          >
          <UiHint
            label="read aloud as"
            text="Used in place of this name in every line, narration and dialogue; the text on screen stays the same."
          />
        </div>
        <input
          v-if="saysOn"
          :value="said ?? c.name"
          class="input w-full"
          :aria-label="`Name read aloud for ${c.name}`"
          @change="castStore.sayName(bookId, c.name, ($event.target as HTMLInputElement).value)"
        />
        <p v-if="uneven" class="text-[11px] font-normal text-zinc-500">
          Only the full name and first name change; keep the same number of words to change each
          part.
        </p>
      </div>
      <div class="flex flex-wrap items-end gap-4">
        <div class="space-y-1 text-xs font-medium">
          <div class="flex items-center gap-1">
            Gender
            <UiHint
              label="gender"
              text="Auto-assign picks this speaker’s voice from those of their gender; with an unknown gender it picks from every voice."
            />
          </div>
          <UiSelect
            :model-value="c.gender"
            :options="GENDERS"
            size="xs"
            class="w-32"
            :aria-label="`Gender for ${c.name}`"
            @update:model-value="
              (g) => castStore.updateCharacter(bookId, c.name, { gender: g as Gender })
            "
          />
        </div>
        <div class="space-y-1 text-xs font-medium">
          <div>Age</div>
          <UiSelect
            :model-value="c.age ?? '?'"
            :options="AGE_OPTIONS"
            size="xs"
            class="w-32"
            :aria-label="`Age for ${c.name}`"
            @update:model-value="
              (a) =>
                castStore.updateCharacter(bookId, c.name, {
                  age: a === '?' ? undefined : (a as Age),
                })
            "
          />
        </div>
        <div class="space-y-1 text-xs font-medium">
          <div class="flex items-center gap-1">
            Pitch
            <UiHint
              label="voice type"
              text="How they sound, from the cast notes or set here. Matched against voice profiles for suggestions and auto-assign; pitch is within their gender."
            />
          </div>
          <UiSelect
            :model-value="c.voiceType?.pitch ?? '?'"
            :options="PITCH_OPTIONS"
            size="xs"
            class="w-24"
            :aria-label="`Pitch for ${c.name}`"
            @update:model-value="
              (v) => setVoiceType({ pitch: v === '?' ? undefined : (v as Pitch) })
            "
          />
        </div>
        <div class="space-y-1 text-xs font-medium">
          <div>Texture</div>
          <UiSelect
            :model-value="c.voiceType?.texture ?? '?'"
            :options="TEXTURE_OPTIONS"
            size="xs"
            class="w-24"
            :aria-label="`Texture for ${c.name}`"
            @update:model-value="
              (v) => setVoiceType({ texture: v === '?' ? undefined : (v as Texture) })
            "
          />
        </div>
        <div class="flex items-center gap-1 pb-1 text-xs font-medium">
          <label class="flex items-center gap-2"
            ><UiSwitch
              :model-value="c.major"
              @update:model-value="(v) => castStore.updateCharacter(bookId, c.name, { major: v })"
            />
            Main cast</label
          >
          <UiHint
            label="main cast"
            text="Main cast get their own card on the Narration stage; minor speakers are collapsed there and read in the Character voice or the Narrator’s until given one."
          />
        </div>
      </div>
      <div class="space-y-1 text-xs font-medium">
        <div>
          Delivery <span class="font-normal text-zinc-400">· up to three, none = unknown</span>
        </div>
        <div class="flex flex-wrap gap-1" role="group" :aria-label="`Delivery for ${c.name}`">
          <button
            v-for="d in DELIVERIES"
            :key="d"
            type="button"
            class="chip"
            :class="delivery.includes(d) ? 'chip-on' : 'chip-off'"
            :aria-pressed="delivery.includes(d)"
            :disabled="!delivery.includes(d) && delivery.length >= 3"
            :data-tip="
              !delivery.includes(d) && delivery.length >= 3
                ? 'Up to three — untick one first'
                : undefined
            "
            @click="toggleDelivery(d)"
          >
            {{ d }}
          </button>
        </div>
      </div>
      <div class="space-y-1 text-xs font-medium">
        <div class="flex items-center gap-1">
          <label :for="styleId">Delivery style</label>
          <UiHint label="delivery style" text="A note carried with every line this speaker has." />
        </div>
        <input
          :value="c.style"
          class="input w-full"
          placeholder="e.g. gravelly, elderly; speaks slowly"
          :id="styleId"
          @input="
            castStore.updateCharacter(bookId, c.name, {
              style: ($event.target as HTMLInputElement).value,
            })
          "
        />
        <p v-if="voiceStyle" class="flex items-center gap-1 text-[11px] font-normal text-zinc-500">
          <span class="min-w-0 truncate">Voice style: ‘{{ voiceStyle }}’</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            class="shrink-0 text-violet-600 hover:underline dark:text-violet-300"
            data-tip="Replaces their delivery style; lines already narrated will show as changed"
            :aria-label="`Use the voice’s style for ${c.name}`"
            @click="castStore.updateCharacter(bookId, c.name, { style: voiceStyle })"
          >
            Use
          </button>
        </p>
      </div>
      <div
        v-for="w in waiting(c.name)"
        :key="w.id"
        class="rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-[11px] dark:border-violet-500/30 dark:bg-violet-500/10"
      >
        <div class="font-medium">Voice samples waiting</div>
        <div class="text-zinc-500">
          {{ plural(w.samples.length, "recording") }} of “{{ w.title }}”,
          {{ sizeLabel(w.samples.reduce((n, x) => n + x.bytes, 0)) }} · from
          {{ w.source }}
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-3">
          <RouterLink
            v-if="samplesStore.cloneLink(bookId, w)"
            :to="samplesStore.cloneLink(bookId, w)!"
            class="text-violet-700 hover:underline dark:text-violet-300"
            >Clone on the Voices tab →</RouterLink
          >
          <RouterLink v-else to="/endpoints" class="text-zinc-500 hover:underline"
            >Add a Fish endpoint to clone this voice</RouterLink
          >
          <button class="text-zinc-500 hover:text-red-600" @click="samplesStore.discard(bookId, w)">
            Discard samples
          </button>
        </div>
      </div>
    </div>

    <div class="space-y-2.5">
      <div class="space-y-1 text-xs font-medium">
        <div>Description</div>
        <SpoilerText :text="describe(c)" :hidden="hides">
          <SpeakerProfile :book-id="bookId" :c="c" :facts="hides" />
        </SpoilerText>
      </div>
      <div class="space-y-1 text-xs font-medium">
        <div class="flex items-center gap-1">
          Also called
          <UiHint
            label="also called"
            text="Names the same speaker is called by, used when matching and searching. To move another speaker’s lines here, tick them in the table and merge instead."
          />
        </div>
        <div class="flex flex-wrap items-center gap-1">
          <span
            v-for="a in c.aliases"
            :key="a"
            class="inline-flex items-center gap-1 rounded-full border border-zinc-200 py-0.5 pl-2 pr-1 text-[11px] font-normal dark:border-zinc-700"
            >{{ a }}
            <button
              class="rounded px-0.5 text-zinc-400 hover:text-red-500"
              :aria-label="`Remove alias ${a}`"
              @click="castStore.removeAlias(bookId, c.name, a)"
            >
              <CloseIcon class="icon-sm" />
            </button>
          </span>
          <span v-if="!c.aliases.length" class="text-[11px] font-normal text-zinc-400">none</span>
        </div>
        <form class="flex items-center gap-1 pt-1" @submit.prevent="addAlias(c)">
          <input
            v-model="alias"
            class="input w-40 py-0.5"
            placeholder="another name"
            :aria-label="`Add an alias for ${c.name}`"
          />
          <button class="btn-ghost btn-xs" type="submit"><AddIcon class="icon-sm" /> Add</button>
        </form>
      </div>
    </div>
    <div v-if="c.name !== 'Narrator'" class="space-y-1 text-xs font-medium lg:col-span-2">
      <div class="flex items-center gap-1">
        Wiki page
        <UiHint
          label="wiki page"
          text="Fills their blank age, gender and voice type from this page; nothing they already have changes. Blank looks them up on the book’s wiki."
        />
        <span v-if="c.wiki" class="ml-2 font-normal text-zinc-400"
          >last filled from
          <SpoilerText :text="c.wiki.url" label="page · show" small>
            <a
              :href="c.wiki.url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-violet-600 hover:underline dark:text-violet-300"
              >page</a
            >
          </SpoilerText></span
        >
      </div>
      <form class="flex items-center gap-1" @submit.prevent="readPage">
        <input
          v-model="pageUrl"
          class="input w-full max-w-md py-0.5"
          inputmode="url"
          :placeholder="wikiHost ? `blank: looked up on ${wikiHost}` : 'https://…fandom.com/wiki/…'"
          :aria-label="`Wiki page for ${c.name}`"
        />
        <button
          class="btn-ghost btn-xs"
          type="submit"
          :disabled="reading || !!fillWhy"
          :data-tip="fillWhy"
        >
          <WikiIcon class="icon-sm" /> {{ reading ? "Reading…" : "Fill" }}
        </button>
      </form>
      <div v-if="found" class="flex flex-wrap items-center gap-1 font-normal" aria-live="polite">
        <span v-for="chip in foundChips" :key="chip" class="chip chip-on">{{ chip }}</span>
        <span v-if="!foundChips.length" class="text-zinc-400">nothing new</span>
        <button v-if="foundChips.length" class="btn-primary btn-xs ml-1" @click="applyPage">
          Apply
        </button>
        <button class="btn-ghost btn-xs" @click="found = null">Dismiss</button>
        <span v-if="found.notes.length" class="w-full truncate text-[11px] text-zinc-400">{{
          found.notes.join(" · ")
        }}</span>
      </div>
    </div>
    <PersonaSection
      v-if="c.name !== 'Narrator'"
      class="border-t border-zinc-200 pt-3 lg:col-span-2 dark:border-zinc-800"
      :book-id="bookId"
      :c="c"
      :lines="lines"
    />
  </div>
</template>
