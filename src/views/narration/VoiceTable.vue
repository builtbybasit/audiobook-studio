<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptsStore } from "@/stores/scripts";

// Cast → voice assignment. Main cast as cards; minor cast collapsed and falling back to the
// Character voice or the Narrator's unless given one; for a linked persona the empty choice is
// their character's voice. Search, "unassigned only", auto-assign by fit or gender.
import { computed, ref, watch } from "vue";

import { SAMPLE_TITLE, useVoiceSample } from "@/composables/useVoiceSample";
import { UiCheckbox, UiDialog, UiToggleGroup, UiTooltip } from "@/ui";
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
  Sparkles as AskAiIcon,
} from "@lucide/vue";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
import { DialogDescription, DialogTitle } from "reka-ui";
import { GENDER } from "@/lib/scriptReview";
import { plural } from "@/lib/contents";
import { describe, voiced } from "@/lib/cast";
import { FIT_MIN } from "@/lib/voiceMatch";
import type { AutoVoiceAssignment, MatchBy } from "@/stores/cast";
import type { Character, Gender } from "@/types";

const props = defineProps<{ bookId: string }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const scriptsStore = useScriptsStore();
// grouped per endpoint; paused endpoints listed but disabled
const voiceOpts = computed(() => endpointsStore.voiceOptions);
const missing = (c: Character) => c.voice && !endpointsStore.resolveVoice(c.voice);
const issueOf = (c: Character) =>
  castStore.routingIssues(props.bookId).find((i) => i.name === c.name);
const q = ref("");
const unassignedOnly = ref(false);
const showMinor = ref(false);
const assignOpen = ref(false);

const all = computed(() => castStore.charactersOf(props.bookId));
const byName = computed(() => castStore.byName[props.bookId] ?? new Map<string, Character>());
const counts = computed(() => scriptsStore.lineCounts(props.bookId));
const match = (c: Character) =>
  (!q.value ||
    c.name.toLowerCase().includes(q.value.toLowerCase()) ||
    c.aliases.some((a) => a.toLowerCase().includes(q.value.toLowerCase()))) &&
  (!unassignedOnly.value || !voiced(c, byName.value));
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
    minor.value
      .filter((c) => !voiced(c, byName.value))
      .map((c) => castStore.fallbackLabel(props.bookId, c.name)),
  );
  return labels.size > 1 ? "Character or Narrator’s voice" : ([...labels][0] ?? "Narrator’s voice");
});
// the button counts by gender, which is cheap; the dialog's plan is made only while it is open
const unvoiced = computed(() => castStore.autoAssignPlan(props.bookId, "gender").length);
const by = ref<MatchBy>("gender");
const refined = ref<AutoVoiceAssignment[] | null>(null);
const refining = ref(false);
watch(assignOpen, (o) => {
  if (o) by.value = castStore.matchBy;
});
watch([assignOpen, by], () => (refined.value = null));
const assignmentPlan = computed(() =>
  assignOpen.value ? (refined.value ?? castStore.autoAssignPlan(props.bookId, by.value)) : [],
);
const fitWeak = computed(() => castStore.matchPool.profiled < FIT_MIN);
const mainInPlan = computed(() => assignmentPlan.value.filter((r) => r.major).length);
const refineBlocker = computed(
  () =>
    castStore.aiBlocker ??
    (!mainInPlan.value ? "No main-cast speaker is waiting for a voice" : undefined),
);
async function refine() {
  refining.value = true;
  const plan = await castStore.refinePlan(props.bookId, assignmentPlan.value);
  if (plan) refined.value = plan;
  refining.value = false;
}
const genderLabel = (g: Gender): string => GENDER[g] ?? "unknown";
/** Opens the Cast page on this speaker. */
const editLink = (c: Character) => ({
  path: `/book/${props.bookId}/cast`,
  query: { speaker: c.name },
});
const voiceSample = useVoiceSample();
/** The voice a speaker is read in: their own, or the one they borrow. */
const heardRef = (c: Character) => castStore.effectiveVoice(props.bookId, c.name).ref;
function applyAssignments() {
  castStore.autoAssign(props.bookId, assignmentPlan.value);
  assignOpen.value = false;
}
</script>

<template>
  <div class="p-3">
    <!-- no summary line: the tab above already reads "Voices 5/22" -->
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <input v-model="q" class="input w-44 py-1" placeholder="Find a speaker…" />
      <label class="flex items-center gap-1.5 text-xs"
        ><UiCheckbox v-model="unassignedOnly" /> Unassigned only</label
      >
      <button class="btn-ghost btn-xs ml-auto" :disabled="!unvoiced" @click="assignOpen = true">
        {{ unvoiced ? `Assign ${unvoiced} unvoiced…` : "All speakers assigned" }}
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
            data-tip="Auto-assign can’t match a speaker without a gender, so it picks from every voice"
            >unknown gender</span
          >
          <span v-else class="text-[11px] text-zinc-400">{{ genderLabel(c.gender) }}</span>
          <RouterLink
            :to="editLink(c)"
            class="icon-btn"
            :class="c.gender === '?' && 'icon-btn-flag'"
            :aria-label="`Edit ${c.name}’s full record`"
            :data-tip="`Gender, description, aliases and main cast for ${c.name} — opens the Cast page on this speaker`"
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
            :text="describe(c)"
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
          >{{ minor.filter((c) => voiced(c, byName)).length }} assigned · rest use the
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
                data-tip="Auto-assign can’t match a speaker without a gender, so it picks from every voice"
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
                :data-tip="`Gender, description, aliases and main cast for ${c.name} — opens the Cast page on this speaker`"
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
      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span class="text-zinc-500">Match by</span>
        <span
          :data-tip="
            fitWeak
              ? `Fit needs profiles on ${FIT_MIN} or more voices (Endpoints → Voices); without them it only spreads voices within each gender`
              : undefined
          "
          ><UiToggleGroup
            v-model="by"
            :options="[
              { value: 'fit', label: 'Fit' },
              { value: 'gender', label: 'Gender' },
            ]"
        /></span>
        <button
          class="btn-ghost btn-xs ml-auto"
          :disabled="refining || !!refineBlocker"
          :data-tip="
            refineBlocker ??
            'The scripting model picks for up to 30 main speakers, each a voice no other main speaker has'
          "
          @click="refine"
        >
          <BusyIcon v-if="refining" class="icon-sm animate-spin" />
          <AskAiIcon v-else class="icon-sm" />
          Refine main cast with AI
        </button>
      </div>
      <DialogDescription class="mt-1 text-xs leading-relaxed text-zinc-500">
        {{
          by === "fit"
            ? "Best fit by gender, age and voice type; main cast never share a voice."
            : "Voices of each gender take turns; a speaker of unknown gender gets any voice."
        }}
        Existing assignments and the Narrator stay unchanged.
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
              {{ genderLabel(row.gender) }}{{ row.matchedGender ? " match" : " · any voice"
              }}<template v-if="row.major"> · main</template>
            </div>
          </div>
          <NextIcon class="icon-sm text-zinc-400" />
          <div class="min-w-0 text-right">
            <div class="truncate">
              <AskAiIcon v-if="row.why" class="icon-sm text-violet-500" aria-label="picked by AI" />
              {{ row.voiceLabel }}
            </div>
            <div class="truncate text-[10px] text-zinc-400">
              {{ row.endpoint
              }}<template v-if="row.reasons?.length"> · {{ row.reasons.join(" · ") }}</template>
            </div>
            <div v-if="row.why" class="text-[10px] text-zinc-500">
              <SpoilerText :text="row.why" label="why · show" small />
            </div>
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
