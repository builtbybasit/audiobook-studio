<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptsStore } from "@/stores/scripts";

// Cast → voice assignment. Main cast as cards; minor cast collapsed and falling back to the
// Character voice or the Narrator's unless given one. Search, "unassigned only", auto-assign by
// gender.
import { computed, ref } from "vue";

import { SAMPLE_TITLE, useVoiceSample } from "@/composables/useVoiceSample";
import { UiCheckbox, UiDialog, UiTooltip } from "@/ui";
import VoicePicker from "@/components/VoicePicker.vue";
import SpoilerText from "@/components/SpoilerText.vue";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  LoaderCircle as BusyIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  TriangleAlert as WarnIcon,
  ArrowRight as NextIcon,
  UserPen as EditCastIcon,
} from "@lucide/vue";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
import { DialogDescription, DialogTitle } from "reka-ui";
import { GENDER } from "@/lib/scriptReview";
import { plural } from "@/lib/contents";
import type { Character, Gender } from "@/types";

const props = defineProps<{ bookId: string }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const scriptsStore = useScriptsStore();
// voices come from the endpoints, which are configured app-wide on /endpoints; grouped per
// endpoint here, paused endpoints listed but disabled
const voiceOpts = computed(() => endpointsStore.voiceOptions);
const missing = (c: Character) => c.voice && !endpointsStore.resolveVoice(c.voice);
const issueOf = (c: Character) =>
  castStore.routingIssues(props.bookId).find((i) => i.name === c.name);
const q = ref("");
const unassignedOnly = ref(false);
const showMinor = ref(false);
const assignOpen = ref(false);

const all = computed(() => castStore.charactersOf(props.bookId));
const counts = computed(() => scriptsStore.lineCounts(props.bookId));
const match = (c: Character) =>
  (!q.value ||
    c.name.toLowerCase().includes(q.value.toLowerCase()) ||
    c.aliases.some((a) => a.toLowerCase().includes(q.value.toLowerCase()))) &&
  (!unassignedOnly.value || !c.voice);
const major = computed(() => all.value.filter((c) => c.major || c.isNew).filter(match));
const minor = computed(() =>
  all.value
    .filter((c) => !c.major && !c.isNew)
    .sort((a, b) => (counts.value[b.name] ?? 0) - (counts.value[a.name] ?? 0))
    .filter(match),
);
const narrator = computed(() => all.value.find((c) => c.name === "Narrator"));
/** What the minor cast with no voice of their own is read in, said once for all of them. */
const minorFallback = computed(() => {
  const labels = new Set(
    minor.value.filter((c) => !c.voice).map((c) => castStore.fallbackLabel(props.bookId, c.name)),
  );
  return labels.size > 1 ? "Character or Narrator’s voice" : ([...labels][0] ?? "Narrator’s voice");
});
const assignmentPlan = computed(() => castStore.autoAssignPlan(props.bookId));
const genderLabel = (g: Gender): string => GENDER[g] ?? "unknown";
/** The Cast page holds the whole record; this opens it on one speaker rather than at the top of a
 *  list you then have to find them in. */
const editLink = (c: Character) => ({
  path: `/book/${props.bookId}/cast`,
  query: { speaker: c.name },
});
const voiceSample = useVoiceSample();
/** The voice a speaker is read in: their own, or the one they borrow. */
const heardRef = (c: Character) => castStore.effectiveVoice(props.bookId, c.name).ref;
function applyAssignments() {
  castStore.autoAssignByGender(props.bookId);
  assignOpen.value = false;
}
</script>

<template>
  <div class="p-3">
    <!-- No summary line: the tab above reads "Voices 5/22", and a speaker with no voice of its own
         shows "Character voice" or "Narrator’s voice" right in its picker. Filters left, bulk
         actions right. -->
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <input v-model="q" class="input w-44 py-1" placeholder="Find a speaker…" />
      <label class="flex items-center gap-1.5 text-xs"
        ><UiCheckbox v-model="unassignedOnly" /> Unassigned only</label
      >
      <button
        class="btn-ghost btn-xs ml-auto"
        :disabled="!assignmentPlan.length"
        @click="assignOpen = true"
      >
        {{
          assignmentPlan.length
            ? `Assign ${assignmentPlan.length} unvoiced…`
            : "All speakers assigned"
        }}
      </button>
      <RouterLink :to="`/book/${bookId}/cast`" class="btn-ghost btn-xs"
        >Full cast <NextIcon class="icon-sm"
      /></RouterLink>
    </div>

    <div
      v-if="!narrator?.voice"
      class="mb-3 rounded-md border border-amber-400 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
    >
      Assign the Narrator’s voice first: narration and every speaker with no other voice are read in
      it.
    </div>
    <div
      v-if="!voiceOpts.length"
      class="mb-3 rounded-md border border-amber-400 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
    >
      No endpoint has any voices yet. A picker here only lists voices that exist on an endpoint, so
      fetch or add some first —
      <RouterLink to="/endpoints" class="underline hover:text-violet-500">Endpoints</RouterLink>.
    </div>

    <div class="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
      <div
        v-for="c in major"
        :key="c.name"
        class="rounded-lg border p-3 text-sm"
        :class="c.isNew ? 'border-dashed border-amber-400' : 'border-zinc-200 dark:border-zinc-800'"
        :style="{ borderTopColor: c.color, borderTopWidth: '3px' }"
      >
        <div class="flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full" :style="{ background: c.color }"></span>
          <b class="min-w-0 flex-1 truncate">{{ c.name }}</b>
          <span
            v-if="c.gender === '?'"
            class="text-[11px] text-amber-600 dark:text-amber-400"
            title="Auto-assign pools voices by gender and skips a speaker without one"
            >unknown gender</span
          >
          <span v-else class="text-[11px] text-zinc-400">{{ genderLabel(c.gender) }}</span>
          <RouterLink
            :to="editLink(c)"
            class="icon-btn"
            :class="c.gender === '?' && 'icon-btn-flag'"
            :aria-label="`Edit ${c.name}’s full record`"
            :title="`Gender, description, aliases and main cast for ${c.name} — opens the Cast page on this speaker`"
          >
            <EditCastIcon class="icon-sm" />
          </RouterLink>
        </div>
        <div class="mt-1 text-[11px] text-zinc-500">
          {{ counts[c.name] ?? 0 }} segments<span v-if="c.aliases.length">
            · a.k.a. {{ c.aliases.join(", ") }}</span
          >
        </div>
        <div class="mt-2 min-h-8 text-xs leading-snug text-zinc-600 dark:text-zinc-400">
          <SpoilerText
            :text="c.description"
            :hidden="c.name !== 'Narrator'"
            empty="No description."
          />
        </div>
        <div class="mt-2 flex items-center gap-1.5">
          <VoicePicker
            :model-value="c.voice"
            @update:model-value="(v) => castStore.setVoice(bookId, c.name, v)"
            :book-id="bookId"
            :speaker="c.name"
            class="min-w-0 flex-1"
            block
          />
          <UiTooltip :text="SAMPLE_TITLE"
            ><button
              class="btn-ghost btn-xs"
              :aria-label="`${voiceSample.playing(heardRef(c)) ? 'Pause' : 'Hear'} ${c.name}'s voice`"
              :disabled="
                !castStore.effectiveVoice(bookId, c.name).voice ||
                (!!voiceSample.loading.value && !voiceSample.fetching(heardRef(c)))
              "
              :aria-busy="voiceSample.fetching(heardRef(c))"
              @click="voiceSample.playRef(heardRef(c))"
            >
              <BusyIcon v-if="voiceSample.fetching(heardRef(c))" class="icon-sm animate-spin" />
              <PauseIcon v-else-if="voiceSample.playing(heardRef(c))" class="icon-sm icon-fill" />
              <PlayIcon v-else class="icon-sm icon-fill" /><span class="text-[9px] text-zinc-400"
                >demo</span
              >
            </button></UiTooltip
          >
        </div>
        <div v-if="issueOf(c)" class="mt-1 text-[11px] text-amber-600">
          <WarnIcon class="icon-sm" /> {{ issueOf(c)!.reason
          }}<template v-if="issueOf(c)!.kind === 'paused'">
            ·
            <button class="underline" @click="issueOf(c)!.endpoint!.enabled = true">
              resume it
            </button>
            or pick another voice</template
          ><template v-else-if="issueOf(c)!.kind === 'missing'"> · pick another voice</template>
        </div>
        <div v-else-if="c.voice" class="mt-1 truncate text-[11px] text-zinc-400">
          on {{ endpointsStore.resolveVoice(c.voice)!.endpoint.name
          }}<template v-if="endpointsStore.resolveVoice(c.voice)!.endpoint.maxChars">
            · splits over
            {{ endpointsStore.resolveVoice(c.voice)!.endpoint.maxChars }} chars</template
          >
        </div>
      </div>
    </div>

    <CollapsibleRoot v-model:open="showMinor" class="mt-3">
      <CollapsibleTrigger
        class="flex w-full items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 data-[state=open]:rounded-b-none dark:border-zinc-800 dark:hover:bg-zinc-800/60"
      >
        <component
          :is="showMinor ? ChevronDownIcon : ChevronRightIcon"
          class="icon-sm text-zinc-400"
        />
        <b>Minor cast ({{ minor.length }})</b>
        <span class="text-xs text-zinc-500"
          >{{ minor.filter((c) => c.voice).length }} assigned · rest use the
          {{ minorFallback }}</span
        >
      </CollapsibleTrigger>
      <CollapsibleContent
        class="rounded-b-lg border border-t-0 border-zinc-200 dark:border-zinc-800"
      >
        <table class="w-full text-sm">
          <tr
            v-for="c in minor"
            :key="c.name"
            class="border-t border-zinc-100 first:border-0 dark:border-zinc-800/70"
          >
            <td class="py-1 pl-3">
              <span
                class="rounded-full px-2 py-0.5 text-xs"
                :style="{ background: c.color + '33', color: c.color }"
                >{{ c.name }}</span
              >
            </td>
            <td class="w-20 text-xs">
              <span
                v-if="c.gender === '?'"
                class="text-amber-600 dark:text-amber-400"
                title="Auto-assign pools voices by gender and skips a speaker without one"
                >unknown</span
              >
              <span v-else class="text-zinc-500">{{ genderLabel(c.gender) }}</span>
            </td>
            <td class="w-16 font-mono text-xs text-zinc-400">{{ counts[c.name] ?? 0 }} seg</td>
            <td class="w-56 py-1">
              <VoicePicker
                :model-value="c.voice"
                @update:model-value="(v) => castStore.setVoice(bookId, c.name, v)"
                :book-id="bookId"
                :speaker="c.name"
                size="xs"
                block
              />
            </td>
            <td class="w-8 py-1 pl-2 pr-3">
              <RouterLink
                :to="editLink(c)"
                class="icon-btn"
                :class="c.gender === '?' && 'icon-btn-flag'"
                :aria-label="`Edit ${c.name}’s full record`"
                :title="`Gender, description, aliases and main cast for ${c.name} — opens the Cast page on this speaker`"
              >
                <EditCastIcon class="icon-sm" />
              </RouterLink>
            </td>
          </tr>
        </table>
      </CollapsibleContent>
    </CollapsibleRoot>

    <UiDialog
      v-model:open="assignOpen"
      class="card flex max-h-[min(36rem,90vh)] w-[min(34rem,92vw)] flex-col p-5 text-sm"
    >
      <DialogTitle class="text-base font-semibold">
        Assign {{ plural(assignmentPlan.length, "unvoiced speaker") }}?
      </DialogTitle>
      <DialogDescription class="mt-1 text-xs leading-relaxed text-zinc-500">
        Enabled endpoints supply the voices. Gender-matched voices are rotated across the cast;
        unknown or unmatched speakers use the available pool. Existing assignments and the Narrator
        stay unchanged.
      </DialogDescription>
      <div class="mt-3 min-h-0 flex-1 overflow-auto rounded-md border dark:border-zinc-800">
        <div
          v-for="row in assignmentPlan"
          :key="row.name"
          class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b px-3 py-2 last:border-0 dark:border-zinc-800"
        >
          <div class="min-w-0">
            <div class="truncate font-medium">{{ row.name }}</div>
            <div class="text-[10px] text-zinc-400">
              {{ genderLabel(row.gender) }}{{ row.matchedGender ? " match" : " · fallback pool" }}
            </div>
          </div>
          <NextIcon class="icon-sm text-zinc-400" />
          <div class="min-w-0 text-right">
            <div class="truncate">{{ row.voiceLabel }}</div>
            <div class="truncate text-[10px] text-zinc-400">{{ row.endpoint }}</div>
          </div>
        </div>
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <button class="btn-ghost" @click="assignOpen = false">Cancel</button>
        <button class="btn-primary" :disabled="!assignmentPlan.length" @click="applyAssignments">
          Assign {{ plural(assignmentPlan.length, "speaker") }}
        </button>
      </div>
      <p class="mt-2 text-right text-[11px] text-zinc-400">
        You can undo the whole assignment from the toast or with ⌘Z.
      </p>
    </UiDialog>
  </div>
</template>
