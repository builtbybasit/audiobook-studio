<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";

// How the audiobook is written. The two questions everyone answers — what format, and one file or
// many — are on the surface with the name and the quality; everything else folds away with its
// current value on the summary line.
import { computed } from "vue";

import {
  BITRATES,
  FORMATS,
  formatOf,
  GROUPINGS,
  LOUDNESS_TARGETS,
  MARKER_PATTERNS,
  markerTitle,
  trackNo,
} from "@/lib/exports";
import { DEFAULT_PACING, secs as secondsOf } from "@/lib/speech";
import { hms, plural, secs } from "@/views/export/shared";
import ExportSection from "@/views/export/ExportSection.vue";
import { UiNumber, UiSelect, UiSwitch, UiToggleGroup } from "@/ui";
import {
  AudioLines as LoudnessIcon,
  BookText as MetaIcon,
  List as MarkerIcon,
  Pause as PauseIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import type { ExportSettings, LoudnessTarget } from "@/types";

const props = defineProps<{
  bookId: string;
  settings: ExportSettings;
  selected: number[];
}>();
const castStore = useCastStore();
const exportsStore = useExportsStore();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
const s = props.settings;
const book = computed(() => libraryStore.bookById(props.bookId)!);
const volumes = computed(() => libraryStore.volumesOf(props.bookId));
const multi = computed(() => volumes.value.length > 1);
const chapters = computed(() =>
  libraryStore.chaptersOf(props.bookId).filter((c) => props.selected.includes(c.id)),
);

const format = computed(() => formatOf(s.format));
/** MP3 carries no chapter marks every player reads; a folder of tracks is how chapters work there. */
const noMarkers = computed(() => !format.value.markers);

// ---- pacing. The book owns the gaps inside a chapter; Export owns only the join between two.
const pacing = computed(() => castStore.pacingOf(props.bookId));
const overrides = computed(() => {
  let n = 0;
  for (const c of chapters.value)
    for (const seg of scriptsStore.segmentsOf(props.bookId, c.id)) if (seg.pause != null) n++;
  return n;
});
const pacingSummary = computed(
  () =>
    `${secondsOf(pacing.value.line)} / ${secondsOf(pacing.value.turn)} between lines · ${secs(s.chapterGap)} between chapters`,
);

// ---- loudness. Simulated end to end; every readout here says so.
const loudness = computed(() => exportsStore.exportLoudnessFor(props.bookId, props.selected, s));
const loudnessSummary = computed(() =>
  s.normalize
    ? `matched to ${s.loudness} LUFS`
    : loudness.value.spread >= 2
      ? `off · voices differ by ${loudness.value.spread} LU`
      : "off",
);

const metaSummary = computed(() =>
  [s.title || "untitled", s.author, s.narrator].filter(Boolean).join(" · "),
);
/** The first selected chapter as the pattern would title it — a real example, not a stock one. */
const markerSummary = computed(() => {
  if (s.grouping === "chapter") return "one chapter per file — no marks needed";
  if (noMarkers.value) return "MP3 carries no chapter marks";
  if (!s.markers) return "off";
  const first = chapters.value[0];
  return first
    ? markerTitle(first, 1, s, volNameOf(first.volumeId))
    : (MARKER_PATTERNS.find((p) => p.value === s.markerPattern)?.sample ?? s.markerPattern);
});

/** Presets per gap, with the built-in default among them so a fresh book shows a chip lit. */
const PACING_PRESETS = {
  line: [0, 0.25, DEFAULT_PACING.line, 0.5, 1],
  turn: [0, 0.5, DEFAULT_PACING.turn, 1, 1.5],
} as const;

const sample = computed(() => chapters.value.slice(0, 3));
const volNameOf = (volumeId: number) => volumes.value.find((v) => v.id === volumeId)?.name ?? null;

function pickCover(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => (s.cover = String(r.result));
  r.readAsDataURL(f);
  input.value = "";
}
const trackSample = computed(() =>
  chapters.value.length ? trackNo(1, chapters.value.length) : "01",
);
</script>

<template>
  <div class="card">
    <!-- the two everyday questions -->
    <div class="space-y-4 p-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <div class="label mb-1.5">Format</div>
          <UiToggleGroup
            v-model="s.format"
            block
            size="sm"
            :options="
              FORMATS.map((f) => ({ value: f.value, label: f.label, class: 'normal-case' }))
            "
          />
          <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{{ format.hint }}</p>
        </div>
        <div>
          <div class="label mb-1.5">Files</div>
          <UiToggleGroup
            v-model="s.grouping"
            block
            size="sm"
            :options="
              GROUPINGS.filter((g) => g.value !== 'volume' || multi).map((g) => ({
                value: g.value,
                label: g.short,
                class: 'normal-case',
              }))
            "
          />
          <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            {{ GROUPINGS.find((g) => g.value === s.grouping)?.hint }}
          </p>
        </div>
      </div>

      <div
        v-if="noMarkers && s.grouping !== 'chapter'"
        class="flex flex-wrap items-center gap-2 rounded-md bg-amber-400/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" />
        <span class="min-w-0 flex-1"
          >MP3 has no chapter marks that every player reads. Listeners will get one long
          track.</span
        >
        <button class="btn-ghost btn-xs border-amber-400" @click="s.grouping = 'chapter'">
          One file per chapter
        </button>
        <button class="btn-ghost btn-xs border-amber-400" @click="s.format = 'm4b'">Use M4B</button>
      </div>

      <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <label class="text-sm"
          >Name
          <div class="input mt-1 flex w-full items-center gap-1 py-0">
            <input
              v-model="s.filename"
              class="min-w-0 flex-1 bg-transparent py-1 focus:outline-none"
              aria-label="Export name"
            /><span class="shrink-0 whitespace-nowrap font-mono text-xs text-zinc-400">{{
              s.grouping === "single"
                ? `.${format.ext}`
                : s.grouping === "volume"
                  ? ` - Vol. 1.${format.ext}`
                  : `/${trackSample} - ….${format.ext}`
            }}</span>
          </div>
        </label>
        <label class="text-sm"
          >Quality
          <UiSelect
            v-model="s.bitrate"
            :options="
              BITRATES.map((b) => ({
                value: b,
                label: `${b} kbps`,
                hint: b <= 48 ? 'small' : b >= 128 ? 'large' : '',
              }))
            "
            class="mt-1"
            block
          />
        </label>
      </div>
    </div>

    <!-- everything else, with its current answer on the fold -->
    <ExportSection title="Book details and cover" :summary="metaSummary" :icon="MetaIcon">
      <div class="grid gap-3 text-sm sm:grid-cols-2">
        <label>Title<input v-model="s.title" class="input mt-1 w-full" /></label>
        <label
          >Series <span class="text-zinc-400">(novel)</span
          ><input v-model="s.series" class="input mt-1 w-full"
        /></label>
        <label>Author<input v-model="s.author" class="input mt-1 w-full" /></label>
        <label>Narrator credit<input v-model="s.narrator" class="input mt-1 w-full" /></label>
        <label
          >Year<UiNumber v-model="s.year" class="mt-1 w-full" align="left" :min="0" label="Year"
        /></label>
        <label class="sm:col-span-2"
          >Description<textarea
            v-model="s.description"
            rows="2"
            class="input mt-1 w-full"
            placeholder="Shown in audiobook players. Leave blank to use the EPUB blurb."
          ></textarea>
        </label>
      </div>
      <div class="mt-4 flex items-center gap-4">
        <img
          v-if="s.cover"
          :src="s.cover"
          class="h-24 w-16 shrink-0 rounded-md object-cover"
          alt="cover"
        />
        <div
          v-else
          class="h-24 w-16 shrink-0 rounded-md"
          :style="{ background: `linear-gradient(160deg, ${book.cover[0]}, ${book.cover[1]})` }"
        ></div>
        <div class="text-sm">
          <div class="font-medium">Cover</div>
          <div class="text-xs text-zinc-500">
            {{
              s.cover
                ? "Your image, embedded in every file."
                : "From the EPUB, embedded in every file."
            }}
          </div>
          <div class="mt-2 flex flex-wrap gap-1">
            <label class="btn-ghost btn-xs cursor-pointer"
              >{{ s.cover ? "Replace…" : "Use my own…"
              }}<input type="file" accept="image/*" class="hidden" @change="pickCover" /></label
            ><button v-if="s.cover" class="btn-ghost btn-xs" @click="s.cover = null">
              Back to the EPUB cover
            </button>
          </div>
        </div>
      </div>
    </ExportSection>

    <ExportSection title="Chapter marks" :summary="markerSummary" :icon="MarkerIcon">
      <p v-if="s.grouping === 'chapter'" class="text-xs leading-relaxed text-zinc-500">
        Each file holds one chapter, so the file names are the chapter list. Players sort them by
        the track number in front of the title.
      </p>
      <p v-else-if="noMarkers" class="text-xs leading-relaxed text-zinc-500">
        MP3 has no chapter marks that every player reads. Switch to M4B, or build one file per
        chapter and let the files be the chapters.
      </p>
      <template v-else>
        <div class="flex flex-wrap items-center gap-3">
          <UiSwitch v-model="s.markers" label="write chapter marks" class="text-sm" />
          <UiSelect
            v-model="s.markerPattern"
            :options="MARKER_PATTERNS.map((p) => ({ value: p.value, label: p.sample }))"
            size="xs"
            class="w-56"
            :disabled="!s.markers"
          />
          <UiSwitch
            v-if="multi && s.grouping === 'single'"
            v-model="s.volPrefix"
            label="prefix with the volume"
            class="text-sm text-zinc-500"
            :disabled="!s.markers"
          />
        </div>
        <div
          v-if="!s.markers"
          class="mt-2 rounded-md bg-amber-400/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          Without marks the player shows one long track — listeners cannot skip by chapter or see
          where they are.
        </div>
        <div
          v-else-if="sample.length"
          class="mt-2 space-y-0.5 rounded-md bg-zinc-50 px-2.5 py-2 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300"
        >
          <div class="mb-1 font-sans text-[10px] uppercase tracking-wider text-zinc-400">
            as the player will list them
          </div>
          <div v-for="(c, i) in sample" :key="c.id" class="truncate">
            {{ markerTitle(c, i + 1, s, volNameOf(c.volumeId)) }}
          </div>
          <div v-if="chapters.length > 3" class="text-zinc-400">
            …and {{ chapters.length - 3 }} more
          </div>
        </div>
      </template>
    </ExportSection>

    <!-- Pauses: the overlap the app used to have twice. It is stated here and edited here, but the
         numbers live on the book, so the reader, the ledger, the duration and the player agree. -->
    <ExportSection title="Pauses" :summary="pacingSummary" :icon="PauseIcon">
      <p class="mb-3 text-xs leading-relaxed text-zinc-500">
        Silence is stitched, never rendered — changing it re-times the book and costs nothing. The
        gaps <b>inside</b> a chapter are the book's own pacing, shared with the reader, the ledger
        and the player; this is the same setting, not a second one.
      </p>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-3">
          <div v-for="k in ['line', 'turn'] as const" :key="k">
            <div class="flex items-center justify-between gap-2 text-xs">
              <span>{{ k === "line" ? "After a line" : "When the speaker changes" }}</span>
              <UiNumber
                class="w-[4.5rem] text-xs"
                :model-value="pacing[k]"
                :min="0"
                :max="5"
                :step="0.05"
                unit="s"
                :label="k === 'line' ? 'Gap after a line' : 'Gap when the speaker changes'"
                @update:model-value="
                  (v: number | null) => castStore.setPacing(bookId, { [k]: v ?? 0 })
                "
              />
            </div>
            <div class="mt-1 flex flex-wrap gap-1">
              <button
                v-for="v in PACING_PRESETS[k]"
                :key="v"
                class="chip"
                :class="pacing[k] === v && 'chip-on'"
                @click="castStore.setPacing(bookId, { [k]: v })"
              >
                {{ secondsOf(v) }}
              </button>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
            <button
              v-if="book.pacing"
              class="btn-ghost btn-xs"
              :title="`back to ${secondsOf(DEFAULT_PACING.line)} / ${secondsOf(DEFAULT_PACING.turn)}`"
              @click="castStore.resetPacing(bookId)"
            >
              Reset to the default
            </button>
            <RouterLink :to="`/book/${bookId}/narration`" class="underline"
              >Per-line pauses live in the reader</RouterLink
            ><span v-if="overrides"
              >· {{ plural(overrides, "line") }} in this selection hold or run on</span
            >
          </div>
        </div>
        <div>
          <div class="flex items-center justify-between gap-2 text-xs">
            <span>Between two chapters</span>
            <UiNumber
              v-model="s.chapterGap"
              class="w-[4.5rem] text-xs"
              :min="0"
              :max="10"
              :step="0.5"
              unit="s"
              label="Gap between chapters"
            />
          </div>
          <div class="mt-1 flex flex-wrap gap-1">
            <button
              v-for="v in [0, 1, 1.5, 2, 3]"
              :key="v"
              class="chip"
              :class="s.chapterGap === v && 'chip-on'"
              @click="s.chapterGap = v"
            >
              {{ secs(v) }}
            </button>
          </div>
          <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
            The only gap Export owns: the join between two chapters does not exist until they are
            stitched into one file.
            <template v-if="s.grouping === 'chapter'"
              >With one file per chapter there is no join, so this adds nothing.</template
            >
            <template v-else-if="chapters.length > 1"
              >It adds {{ hms(s.chapterGap * (chapters.length - 1)) }} to this selection.</template
            >
          </p>
        </div>
      </div>
    </ExportSection>

    <ExportSection
      title="Loudness"
      :summary="loudnessSummary"
      :icon="LoudnessIcon"
      :note="!s.normalize && loudness.spread >= 3 ? 'uneven' : ''"
    >
      <p class="mb-3 text-xs leading-relaxed text-zinc-500">
        A book read by several voices from several providers arrives at several different levels,
        and a listener reaches for the volume knob long before they notice the bitrate. Matching
        them applies one gain per clip; no clip is re-rendered and nothing is billed.
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <UiSwitch v-model="s.normalize" label="match every voice to one level" class="text-sm" />
        <UiSelect
          :model-value="s.loudness"
          :options="LOUDNESS_TARGETS.map((t) => ({ value: t.value, label: t.label, hint: t.hint }))"
          size="xs"
          class="w-64"
          :disabled="!s.normalize"
          @update:model-value="(v) => (s.loudness = Number(v) as LoudnessTarget)"
        />
      </div>

      <div v-if="!loudness.voices.length" class="mt-3 text-xs text-zinc-500">
        Select some narrated chapters to see the voices they use.
      </div>
      <div v-else class="mt-3">
        <div class="mb-1.5 flex flex-wrap items-baseline gap-x-3 text-xs">
          <span class="text-zinc-500"
            >{{ plural(loudness.voices.length, "voice") }} in this selection</span
          >
          <span
            :class="loudness.spread >= 3 ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500'"
            >{{ loudness.spread }} LU between the quietest and the loudest</span
          >
        </div>
        <ul class="space-y-1">
          <li v-for="v in loudness.voices" :key="v.ref" class="flex items-center gap-2 text-xs">
            <span class="min-w-0 flex-1 truncate" :title="`${v.label} · ${v.endpoint}`"
              >{{ v.label }} <span class="text-zinc-400">· {{ v.endpoint }}</span></span
            >
            <span class="w-24 shrink-0 text-right font-mono text-zinc-500"
              >{{ v.lufs.toFixed(1) }} LUFS</span
            >
            <span
              class="w-16 shrink-0 text-right font-mono"
              :class="
                !s.normalize
                  ? 'text-zinc-300 dark:text-zinc-600'
                  : Math.abs(v.gain) >= 3
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-600'
              "
              >{{ s.normalize ? `${v.gain > 0 ? "+" : ""}${v.gain.toFixed(1)} dB` : "—" }}</span
            >
          </li>
        </ul>
        <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
          These levels are invented from each voice's identity, not measured: this prototype renders
          no audio and applies no gain. In a real build they would come from an analysis pass over
          the rendered clips.
        </p>
      </div>
    </ExportSection>
  </div>
</template>
