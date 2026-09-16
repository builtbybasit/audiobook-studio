<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";

// Book overview: volumes, pipeline progress per stage, cast summary, latest exports, and what to do next.
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { isScripted } from "@/lib/scriptReview";
import { isNarrated } from "@/lib/scriptReview";
import {
  ChevronUp as MoveUpIcon,
  ChevronDown as MoveDownIcon,
  GripVertical as GripIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as AddIcon,
  ArrowRight as NextIcon,
} from "@lucide/vue";
import { UiNumber } from "@/ui";
import type { Volume } from "@/types";
import { useBookId } from "@/router";

const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const exportsStore = useExportsStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();
const bookId = useBookId();
const router = useRouter();
// the router only reaches this view with a real book id
const book = computed(() => libraryStore.bookById(bookId)!);
const chapters = computed(() => libraryStore.chaptersOf(bookId));
const p = computed(() => libraryStore.progress(bookId));
const cast = computed(() => castStore.charactersOf(bookId));
const unreviewed = computed(() => cast.value.filter((c) => c.isNew).length);
const unvoiced = computed(() => cast.value.filter((c) => !c.voice && c.major).length);
const suggestions = computed(() => castStore.mergeSuggestions(bookId).length);
const exportsHere = computed(() =>
  exportsStore.exports.filter((e) => e.bookId === bookId && e.status === "done"),
);
/** A finished audiobook that no longer matches the book — new chapters, or chapters re-rendered. */
const behind = computed(() =>
  exportsHere.value.some((e) => exportsStore.exportUpdateFor(e).needed),
);
const editing = ref<number | null>(null);
const draft = ref("");
const removing = ref<number | null>(null);
const dragging = ref<number | null>(null);
const dragOver = ref<number | null>(null);
function drop(toIndex: number) {
  if (dragging.value != null) libraryStore.moveVolume(bookId, dragging.value, toIndex);
  dragging.value = null;
  dragOver.value = null;
}
function saveName(v: Volume) {
  libraryStore.renameVolume(bookId, v.id, draft.value);
  editing.value = null;
}
function remove(v: Volume) {
  const r = libraryStore.removeVolume(bookId, v.id);
  removing.value = null;
  if (r === "book") router.push("/library");
}
const budget = computed(() => book.value.budget ?? { cap: null, paused: false });
const spent = computed(() => jobsStore.spent(bookId));
const scriptSpent = computed(() => jobsStore.scriptSpent(bookId));
const narrationSpent = computed(() => Math.max(0, spent.value - scriptSpent.value));
const capInput = computed({
  get: () => book.value.budget?.cap ?? null,
  set: (v) => libraryStore.setBudgetCap(bookId, v || null),
});
const volStats = (v: Volume) => {
  const chs = chapters.value.filter((c) => c.volumeId === v.id);
  return {
    n: chs.length,
    scripted: chs.filter(isScripted).length,
    narrated: chs.filter(isNarrated).length,
  };
};
const fmt = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
    : `${Math.floor(s / 60)}m`;
const runtime = computed(() => chapters.value.reduce((a, c) => a + c.duration, 0));

// the single most useful next action
const next = computed(() => {
  const failedS = chapters.value.filter((c) => c.scripting === "failed").length;
  const failedN = chapters.value.filter((c) => c.narration === "failed").length;
  if (p.value.scripted === 0)
    return {
      text: "Nothing is scripted yet. Run scripting on the first few chapters to extract the cast.",
      to: "scripting",
      label: "Start scripting",
    };
  if (unreviewed.value)
    return {
      text: `${unreviewed.value} newly detected speaker${unreviewed.value > 1 ? "s" : ""} need${unreviewed.value > 1 ? "" : "s"} review — probably aliases to merge.`,
      to: "cast",
      label: "Review cast",
    };
  if (failedS)
    return {
      text: `${failedS} chapter${failedS > 1 ? "s" : ""} failed scripting.`,
      to: "scripting",
      label: "Retry scripting",
    };
  if (p.value.fallback)
    return {
      text: `${p.value.fallback} chapter${p.value.fallback > 1 ? "s" : ""} kept a chunk as plain narration because it didn’t verify.`,
      to: "scripting",
      label: "Inspect fallbacks",
    };
  if (unvoiced.value)
    return {
      text: `${unvoiced.value} main character${unvoiced.value > 1 ? "s" : ""} still use${unvoiced.value > 1 ? "" : "s"} the Narrator’s voice.`,
      to: "narration",
      label: "Assign voices",
    };
  if (p.value.stale)
    return {
      text: `${p.value.stale} chapter${p.value.stale > 1 ? "s" : ""} edited after narration — audio is stale.`,
      to: "narration",
      label: "Re-narrate changes",
    };
  if (failedN)
    return {
      text: `${failedN} chapter${failedN > 1 ? "s" : ""} have failed segments.`,
      to: "narration",
      label: "Retry narration",
    };
  if (p.value.narrated < p.value.scripted)
    return {
      text: `${p.value.scripted - p.value.narrated} scripted chapter${p.value.scripted - p.value.narrated > 1 ? "s are" : " is"} not narrated yet.`,
      to: "narration",
      label: "Narrate",
    };
  if (p.value.scripted < p.value.total)
    return {
      text: `${p.value.total - p.value.scripted} chapter${p.value.total - p.value.scripted > 1 ? "s" : ""} still to script.`,
      to: "scripting",
      label: "Continue scripting",
    };
  const fresh = behind.value;
  if (!exportsHere.value.length || fresh)
    return {
      text: fresh
        ? "New chapters narrated since the last audiobook build."
        : "Everything is narrated. Build the audiobook.",
      to: "export",
      label: fresh ? "Rebuild audiobook" : "Build audiobook",
    };
  return { text: "This book is complete and exported.", to: "export", label: "Exports" };
});
</script>

<template>
  <div v-if="book" class="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
    <div class="flex flex-col gap-5 sm:flex-row">
      <div
        class="h-40 w-28 shrink-0 rounded-lg shadow-lg"
        :style="{ background: `linear-gradient(160deg, ${book.cover[0]}, ${book.cover[1]})` }"
      ></div>
      <div class="min-w-0 flex-1">
        <h1 class="font-serif text-3xl">{{ book.title }}</h1>
        <div class="text-zinc-500">
          {{ book.author }} · {{ chapters.length }} chapters · {{ book.volumes.length }} volume{{
            book.volumes.length > 1 ? "s" : ""
          }}
          · {{ cast.length }} speakers<span v-if="runtime"> · {{ fmt(runtime) }} narrated</span>
        </div>
        <div
          class="mt-4 flex items-center gap-3 rounded-lg border border-violet-300 bg-violet-50 px-4 py-3 dark:border-violet-500/40 dark:bg-violet-500/10"
        >
          <NextIcon class="icon-lg shrink-0 text-violet-500" />
          <span class="flex-1 text-sm">{{ next.text }}</span>
          <RouterLink :to="`/book/${bookId}/${next.to}`" class="btn-primary whitespace-nowrap">{{
            next.label
          }}</RouterLink>
        </div>
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-3">
      <RouterLink :to="`/book/${bookId}/scripting`" class="card p-4 hover:border-violet-400">
        <div class="flex items-baseline justify-between">
          <span class="label">1 · Scripting</span
          ><span class="font-mono text-xs text-zinc-500">{{ p.scripted }}/{{ p.total }}</span>
        </div>
        <div class="mt-2 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800">
          <div
            class="h-1.5 rounded bg-amber-500"
            :style="{ width: (p.scripted / p.total) * 100 + '%' }"
          ></div>
        </div>
        <div class="mt-2 text-xs text-zinc-500">
          <span v-if="p.fallback" class="text-amber-600"
            >{{ p.fallback }} with fallback chunks · </span
          >{{ chapters.filter((c) => c.scripting === "failed").length }} failed
        </div>
      </RouterLink>
      <RouterLink :to="`/book/${bookId}/narration`" class="card p-4 hover:border-violet-400">
        <div class="flex items-baseline justify-between">
          <span class="label">2 · Narration</span
          ><span class="font-mono text-xs text-zinc-500">{{ p.narrated }}/{{ p.total }}</span>
        </div>
        <div class="mt-2 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800">
          <div
            class="h-1.5 rounded bg-sky-500"
            :style="{ width: (p.narrated / p.total) * 100 + '%' }"
          ></div>
        </div>
        <div class="mt-2 text-xs text-zinc-500">
          <span v-if="p.stale" class="text-amber-600">{{ p.stale }} stale · </span
          >{{ chapters.filter((c) => c.narration === "failed").length }} failed ·
          {{ cast.filter((c) => c.voice).length }}/{{ cast.length }} voiced
        </div>
      </RouterLink>
      <RouterLink :to="`/book/${bookId}/export`" class="card p-4 hover:border-violet-400">
        <div class="flex items-baseline justify-between">
          <span class="label">3 · Export</span
          ><span class="font-mono text-xs text-zinc-500"
            >{{ exportsHere.length }} audiobook{{ exportsHere.length === 1 ? "" : "s" }}</span
          >
        </div>
        <div v-if="exportsHere.length" class="mt-2 truncate font-mono text-xs">
          {{ exportsHere[0].filename }}
          <span class="text-zinc-400"
            >v{{ exportsHere[0].version
            }}<template v-if="exportsHere[0].files.length > 1">
              · {{ exportsHere[0].files.length }} files</template
            ></span
          >
        </div>
        <div v-else class="mt-2 text-xs text-zinc-500">No audiobook built yet.</div>
        <div class="mt-2 text-xs" :class="behind ? 'text-violet-500' : 'text-zinc-500'">
          {{
            behind ? "behind the book — needs an update" : exportsHere.length ? "up to date" : ""
          }}
        </div>
      </RouterLink>
    </div>

    <div class="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div class="card">
        <div
          class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"
        >
          <span class="label">Volumes</span
          ><span class="hidden text-[11px] text-zinc-400 sm:inline"
            >drag or <MoveUpIcon class="icon-sm" /><MoveDownIcon class="icon-sm" /> to reorder ·
            chapters renumber to match</span
          ><label class="ml-auto cursor-pointer text-xs text-zinc-400 hover:text-violet-500"
            ><AddIcon class="icon-sm" /> add volume<input
              type="file"
              accept=".epub"
              class="hidden"
              @change="
                (e: Event) =>
                  libraryStore.addVolume(
                    bookId,
                    (e.target as HTMLInputElement).files?.[0]?.name ?? 'volume.epub',
                  )
              "
          /></label>
        </div>
        <div
          v-for="(v, vi) in book.volumes"
          :key="v.id"
          class="border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-zinc-800/70"
          :class="[
            dragOver === v.id && dragging !== v.id && 'bg-violet-50 dark:bg-violet-500/10',
            dragging === v.id && 'opacity-40',
          ]"
          draggable="true"
          @dragstart="dragging = v.id"
          @dragend="
            dragging = null;
            dragOver = null;
          "
          @dragover.prevent="dragOver = v.id"
          @dragleave="dragOver === v.id && (dragOver = null)"
          @drop.prevent="drop(vi)"
        >
          <div class="flex flex-wrap items-center gap-3">
            <span class="flex flex-col items-center text-zinc-300 dark:text-zinc-600">
              <button
                class="text-[10px] leading-none hover:text-violet-500 disabled:invisible"
                :disabled="vi === 0"
                title="move up"
                @click="libraryStore.moveVolume(bookId, v.id, vi - 1)"
              >
                <MoveUpIcon class="icon-sm" />
              </button>
              <span class="cursor-grab select-none leading-none" title="drag to reorder"
                ><GripIcon class="icon"
              /></span>
              <button
                class="text-[10px] leading-none hover:text-violet-500 disabled:invisible"
                :disabled="vi === book.volumes.length - 1"
                title="move down"
                @click="libraryStore.moveVolume(bookId, v.id, vi + 1)"
              >
                <MoveDownIcon class="icon-sm" />
              </button>
            </span>
            <span
              class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-zinc-100 font-mono text-sm dark:bg-zinc-800"
              >{{ vi + 1 }}</span
            >
            <div class="group min-w-0 flex-1">
              <form
                v-if="editing === v.id"
                class="flex items-center gap-1"
                @submit.prevent="saveName(v)"
              >
                <input
                  v-model="draft"
                  class="input w-64 py-0.5 text-sm"
                  autofocus
                  @keydown.esc="editing = null"
                />
                <button class="btn-primary btn-xs" type="submit">Save</button
                ><button class="btn-ghost btn-xs" type="button" @click="editing = null">
                  Cancel
                </button>
              </form>
              <div v-else class="flex items-center gap-2">
                <span class="truncate text-sm font-medium">{{ v.name }}</span
                ><button
                  class="text-[11px] text-zinc-400 opacity-0 hover:text-violet-500 group-hover:opacity-100"
                  title="rename volume"
                  @click="
                    editing = v.id;
                    draft = v.name;
                  "
                >
                  rename
                </button>
              </div>
              <div class="truncate font-mono text-[11px] text-zinc-400">
                {{ v.file }} · ch {{ v.from }}–{{ v.to }}
              </div>
            </div>
            <div class="w-full text-xs text-zinc-500 sm:w-40">
              <div class="flex justify-between">
                <span>scripted</span><span>{{ volStats(v).scripted }}/{{ volStats(v).n }}</span>
              </div>
              <div class="h-1 rounded bg-zinc-200 dark:bg-zinc-800">
                <div
                  class="h-1 rounded bg-amber-500"
                  :style="{ width: (volStats(v).scripted / volStats(v).n) * 100 + '%' }"
                ></div>
              </div>
              <div class="mt-1 flex justify-between">
                <span>narrated</span><span>{{ volStats(v).narrated }}/{{ volStats(v).n }}</span>
              </div>
              <div class="h-1 rounded bg-zinc-200 dark:bg-zinc-800">
                <div
                  class="h-1 rounded bg-sky-500"
                  :style="{ width: (volStats(v).narrated / volStats(v).n) * 100 + '%' }"
                ></div>
              </div>
            </div>
            <button
              class="text-[11px] text-zinc-400 hover:text-red-500"
              title="remove this volume (wrong EPUB?)"
              @click="removing = removing === v.id ? null : v.id"
            >
              remove
            </button>
          </div>
          <div
            v-if="removing === v.id"
            class="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-500/5 px-3 py-2 text-xs dark:border-red-500/40"
          >
            <span
              >Remove <b>{{ v.name }}</b> ({{ v.file }})? Its {{ volStats(v).n }} chapters<template
                v-if="volStats(v).scripted"
              >
                · {{ volStats(v).scripted }} scripted</template
              ><template v-if="volStats(v).narrated">
                · {{ volStats(v).narrated }} narrated</template
              >
              are deleted and the rest are renumbered.<template v-if="book.volumes.length === 1">
                This is the only volume, so the novel is removed from the library.</template
              ></span
            >
            <span class="ml-auto flex gap-1"
              ><button class="btn-ghost btn-xs" @click="removing = null">Keep</button
              ><button
                class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500"
                @click="remove(v)"
              >
                Remove volume
              </button></span
            >
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <RouterLink :to="`/book/${bookId}/cast`" class="card block p-4 hover:border-violet-400">
          <div class="flex items-baseline justify-between">
            <span class="label">Cast</span
            ><span class="text-xs text-zinc-500">open <NextIcon class="icon-sm" /></span>
          </div>
          <div class="mt-2 flex flex-wrap gap-1">
            <span
              v-for="c in cast.filter((c) => c.major).slice(0, 8)"
              :key="c.name"
              class="rounded-full px-2 py-0.5 text-xs"
              :style="{ background: c.color + '33', color: c.color }"
              >{{ c.name }}</span
            >
            <span
              class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800"
              >+{{ cast.filter((c) => !c.major).length }} minor</span
            >
          </div>
          <div class="mt-2 text-xs text-zinc-500">
            <span v-if="unreviewed" class="text-amber-600">{{ unreviewed }} unreviewed · </span>
            <span v-if="suggestions" class="text-violet-500"
              >{{ suggestions }} merge suggestion{{ suggestions > 1 ? "s" : "" }} ·
            </span>
            {{ cast.filter((c) => c.voice).length }} voiced
          </div>
        </RouterLink>
        <div class="card p-4">
          <div class="flex items-center justify-between">
            <span class="label">Budget</span
            ><span class="text-xs" :class="budget.paused ? 'text-amber-600' : 'text-zinc-500'">{{
              budget.paused ? "paused" : "running normally"
            }}</span>
          </div>
          <div class="mt-2 flex items-baseline gap-2 text-sm">
            <b class="text-lg">${{ spent.toFixed(2) }}</b
            ><span class="text-zinc-500">spent on this book</span>
          </div>
          <div class="mt-0.5 text-[11px] text-zinc-500">
            Scripting ${{ scriptSpent.toFixed(2) }} · Narration ${{ narrationSpent.toFixed(2) }}
          </div>
          <div v-if="budget.cap" class="mt-1">
            <div class="h-1.5 rounded bg-zinc-200 dark:bg-zinc-800">
              <div
                class="h-1.5 rounded"
                :class="spent / budget.cap > 0.9 ? 'bg-red-500' : 'bg-amber-500'"
                :style="{ width: Math.min(100, (spent / budget.cap) * 100) + '%' }"
              ></div>
            </div>
            <div class="mt-0.5 text-[11px] text-zinc-500">
              {{ Math.round((spent / budget.cap) * 100) }}% of the ${{ budget.cap }} cap · runs that
              would cross it are blocked
            </div>
          </div>
          <div class="mt-2 flex items-center gap-2 text-xs">
            <span class="text-zinc-500">Cap $</span
            ><UiNumber
              v-model="capInput"
              class="w-24"
              :min="0"
              :step="1"
              :empty="null"
              placeholder="none"
              label="Spend cap for this book"
            /><span class="text-zinc-400">scripting + narration</span>
          </div>
          <button
            class="btn-ghost btn-xs mt-3 w-full justify-center"
            :class="
              budget.paused
                ? 'border-emerald-400 text-emerald-600'
                : 'border-amber-400 text-amber-600'
            "
            @click="
              budget.paused ? libraryStore.resumeBook(bookId) : libraryStore.pauseBook(bookId)
            "
          >
            <component :is="budget.paused ? PlayIcon : PauseIcon" class="icon-sm icon-fill" />
            {{ budget.paused ? "Resume this book" : "Pause new work on this book" }}
          </button>
        </div>
        <div class="card p-4 text-xs text-zinc-500">
          <div class="label mb-1">Scripting profile</div>
          <div class="text-sm text-zinc-900 dark:text-zinc-100">
            {{
              endpointsStore.profiles.find((x) => x.id === scriptingStore.scriptSettings.profile)
                ?.name
            }}
            ·
            <span class="font-mono">{{
              endpointsStore.profiles.find((x) => x.id === scriptingStore.scriptSettings.profile)
                ?.model
            }}</span>
          </div>
          <div class="mt-1">
            {{
              (
                endpointsStore.profiles.find((x) => x.id === scriptingStore.scriptSettings.profile)
                  ?.maxChars ?? 0
              ).toLocaleString()
            }}
            chars/chunk · watermarks
            {{ scriptingStore.scriptSettings.stripWatermarks ? "stripped" : "kept" }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
