<script setup lang="ts">
// One speaker's full record — every field a speaker has, in the one place that has them all. The
// Cast table opens it under a row; it reads and writes the speaker through the cast store.
import { ref } from "vue";

import { useCastStore } from "@/stores/cast";
import { useSpeakerSamplesStore } from "@/stores/speakerSamples";
import { plural } from "@/lib/contents";
import { sizeLabel } from "@/lib/audioFormat";
import { GENDER } from "@/lib/scriptReview";
import { UiSelect, UiSwitch } from "@/ui";
import VoicePicker from "@/components/VoicePicker.vue";
import { Plus as AddIcon, X as CloseIcon } from "@lucide/vue";
import type { Character, Gender } from "@/types";

const props = defineProps<{ bookId: string; c: Character }>();

const castStore = useCastStore();
const samplesStore = useSpeakerSamplesStore();
const bookId = props.bookId;

const GENDERS = (["f", "m", "n", "?"] as Gender[]).map((value) => ({
  value,
  label: GENDER[value] ?? "unknown",
}));

// Voice samples a script file brought for a speaker whose voice this install cannot reach: they
// wait on the speaker's record, with the way to clone them and the way to let them go.
/** A speaker's waiting samples as a list of none or one, for the template to loop over. */
const waiting = (name: string) => {
  const w = samplesStore.waitingFor(bookId, name);
  return w ? [w] : [];
};

const alias = ref("");
function addAlias(c: Character) {
  if (castStore.addAlias(bookId, c.name, alias.value)) alias.value = "";
}
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-2">
    <div class="space-y-2.5">
      <label class="block space-y-1 text-xs font-medium"
        ><span>Name</span
        ><input
          :value="c.name"
          class="input w-full"
          @change="
            castStore.renameCharacter(bookId, c.name, ($event.target as HTMLInputElement).value)
          "
        />
        <span class="block text-[11px] font-normal text-zinc-500"
          >Renaming re-points every line. Typing an existing speaker’s name merges into them.</span
        ></label
      >
      <div class="flex flex-wrap items-end gap-3">
        <label class="space-y-1 text-xs font-medium"
          ><span>Gender</span>
          <UiSelect
            :model-value="c.gender"
            :options="GENDERS"
            size="xs"
            class="w-32"
            :aria-label="`Gender for ${c.name}`"
            @update:model-value="
              (g) => castStore.updateCharacter(bookId, c.name, { gender: g as Gender })
            "
        /></label>
        <label class="flex items-center gap-2 pb-1 text-xs font-medium"
          ><UiSwitch
            :model-value="c.major"
            @update:model-value="(v) => castStore.updateCharacter(bookId, c.name, { major: v })"
          />
          Main cast</label
        >
      </div>
      <p class="text-[11px] leading-relaxed text-zinc-500">
        Gender pools the voices auto-assign draws from — an unknown is skipped. Main cast get their
        own card on the Narration stage; minor speakers are collapsed there and read in the
        Narrator’s voice until given one.
      </p>
      <label class="block space-y-1 text-xs font-medium"
        ><span>Voice</span>
        <VoicePicker
          :model-value="c.voice"
          @update:model-value="(v) => castStore.setVoice(bookId, c.name, v)"
          :book-id="bookId"
          :speaker="c.name"
          block
      /></label>
      <div
        v-for="w in waiting(c.name)"
        :key="w.id"
        class="rounded border border-violet-200 bg-violet-50 px-2 py-1.5 text-[11px] dark:border-violet-500/30 dark:bg-violet-500/10"
      >
        <div class="font-medium">Samples waiting</div>
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
      <label class="block space-y-1 text-xs font-medium"
        ><span>Delivery style</span
        ><input
          :value="c.style"
          class="input w-full"
          placeholder="e.g. gravelly, elderly; speaks slowly"
          @input="
            castStore.updateCharacter(bookId, c.name, {
              style: ($event.target as HTMLInputElement).value,
            })
          "
        />
        <span class="block text-[11px] font-normal text-zinc-500"
          >A note carried with every line this speaker has.</span
        ></label
      >
    </div>

    <div class="space-y-2.5">
      <label class="block space-y-1 text-xs font-medium"
        ><span>Description</span
        ><textarea
          :value="c.description"
          rows="4"
          class="input w-full resize-y leading-relaxed"
          placeholder="Who they are — kept out of the way on the Narration cards because it spoils."
          @input="
            castStore.updateCharacter(bookId, c.name, {
              description: ($event.target as HTMLTextAreaElement).value,
            })
          "
        ></textarea>
      </label>
      <div class="space-y-1 text-xs font-medium">
        <span>Also called</span>
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
        <p class="text-[11px] font-normal leading-relaxed text-zinc-500">
          Names the same speaker is called by, used when matching and searching. To move another
          speaker’s lines here, tick them above and merge instead.
        </p>
      </div>
    </div>
  </div>
</template>
