<script setup>
// Export: assemble narrated chapters into M4B files. Repeatable — as volumes arrive, rebuild with the
// same filename to replace the previous audiobook (versioned), or split one file per volume with
// volume metadata (series / volume N of M).
import { computed, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useApp, isNarrated } from "../stores/app";
import { usePlayer } from "../composables/usePlayer";
import EmptyState from "../components/EmptyState.vue";
import { UiSelect, UiSwitch } from "../ui";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import ChapterPicker from "../components/ChapterPicker.vue";

const app = useApp();
const bookId = useRoute().params.bookId;
const book = computed(() => app.bookById(bookId));
const multi = computed(() => book.value.volumes.length > 1);
const selected = ref(
  app
    .chaptersOf(bookId)
    .filter(isNarrated)
    .map((c) => c.id),
);
const anyNarrated = computed(() => app.chaptersOf(bookId).some(isNarrated));
const staleSelected = computed(
  () => selChapters.value.filter((c) => c.narration === "stale").length,
);
const meta = reactive({
  title: book.value.title,
  series: book.value.title,
  author: book.value.author,
  narrator: "OpenAI TTS · multi-voice",
  year: new Date().getFullYear(),
  description: "",
  filename: book.value.title,
  bitrate: 96,
  gapSeg: 0.35,
  gapCh: 2.0,
  volPrefix: true,
  splitPerVolume: false,
  cover: null,
  markers: true,
  markerPattern: "{n}. {title}",
});
const { p: player, play } = usePlayer();
const PATTERNS = [
  { value: "{n}. {title}", label: "1. The Silent Peak" },
  { value: "Chapter {n} — {title}", label: "Chapter 1 — The Silent Peak" },
  { value: "{title}", label: "The Silent Peak" },
  { value: "Chapter {n}", label: "Chapter 1" },
];
const marker = (c, i) =>
  meta.markerPattern
    .replace("{n}", i + 1)
    .replace(
      "{title}",
      (multi.value && meta.volPrefix && !meta.splitPerVolume ? shortVol(volName(c)) + " · " : "") +
        c.title,
    );
function pickCover(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => (meta.cover = r.result);
  r.readAsDataURL(f);
  e.target.value = "";
}
const pathOf = (e) => `~/Audiobooks/${(e.series || e.title).replace(/[/:]/g, "-")}/${e.filename}`;
function copyPath(e) {
  navigator.clipboard?.writeText(pathOf(e));
  app.toast("Path copied", { kind: "success", timeout: 2500 });
}
function download(e) {
  const work = new Promise((res) => setTimeout(res, 1800));
  app.toastLoading(work, {
    loading: `Preparing ${e.filename} (${e.size} MB)…`,
    success: `${e.filename} is ready`,
    error: "Download failed",
  });
}
const tab = ref("metadata");

const selChapters = computed(() =>
  app.chaptersOf(bookId).filter((c) => selected.value.includes(c.id)),
);
const totalDur = computed(() => selChapters.value.reduce((a, c) => a + c.duration, 0));
const fmt = (s) =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
    : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
const estSize = (dur) => Math.round(((dur * meta.bitrate) / 8 / 1024) * 1.04);
const volName = (c) => book.value.volumes.find((v) => v.id === c.volumeId)?.name ?? "";
const shortVol = (name) => name.split("·")[0].trim();

// what will be built: one plan entry per output file
const plan = computed(() => {
  if (!meta.splitPerVolume)
    return [
      {
        filename: app.exportFilename(meta, null),
        title: meta.title,
        volume: null,
        chapters: selChapters.value,
      },
    ];
  return book.value.volumes
    .map((v, i) => ({
      filename: app.exportFilename(meta, v),
      title: `${meta.title} · ${shortVol(v.name)}`,
      volume: { number: i + 1, of: book.value.volumes.length, name: v.name },
      chapters: selChapters.value.filter((c) => c.volumeId === v.id),
    }))
    .filter((p) => p.chapters.length);
});
const existing = (filename) =>
  app.exports.find((e) => e.bookId === bookId && e.filename === filename && e.status === "done");

const exportsHere = computed(() =>
  app.exports.filter((e) => e.bookId === bookId && e.status !== "replaced"),
);
const olderOf = (e) =>
  app.exports.filter(
    (x) => x.bookId === bookId && x.filename === e.filename && x.status === "replaced",
  );
const showOld = ref(new Set());
function rebuild(e) {
  // same filename, previous chapters + everything narrated since
  const ids = [...new Set([...e.chapterIds, ...app.newSince(e)])];
  const m = {
    ...meta,
    title: e.series ?? meta.title,
    series: e.series,
    filename: e.filename.replace(/ - .*\.m4b$/, "").replace(/\.m4b$/, ""),
    splitPerVolume: false,
  };
  if (e.volume) {
    const v = book.value.volumes[e.volume.number - 1];
    app._buildOne(
      bookId,
      {
        vol: v,
        index: e.volume.number,
        chapters: app.chaptersOf(bookId).filter((c) => ids.includes(c.id)),
      },
      m,
    );
  } else app.buildExport(bookId, ids, m);
}
</script>

<template>
  <div class="grid gap-4 p-4 lg:h-full lg:grid-cols-[300px_1fr] lg:grid-rows-[minmax(0,1fr)]">
    <div class="h-[50vh] min-h-0 lg:h-auto">
      <ChapterPicker
        :book-id="bookId"
        stage="export"
        v-model="selected"
        run-label="Build audiobook"
        :selectable="(c) => isNarrated(c) && !c.excluded"
        @run="(ids) => app.buildExport(bookId, ids, meta)"
      />
    </div>

    <EmptyState
      v-if="!anyNarrated"
      icon="⤓"
      title="Nothing narrated yet"
      body="An audiobook is built from narrated chapters. Narrate at least one chapter, then come back to build an M4B."
      :steps="[
        'Script chapters',
        'Assign voices and narrate',
        'Build — rebuild later as more chapters finish',
      ]"
    >
      <RouterLink :to="`/book/${bookId}/narration`" class="btn-primary">Go to Narration</RouterLink>
    </EmptyState>
    <div v-else class="grid min-h-0 gap-4 lg:grid-cols-[1fr_340px] lg:grid-rows-[minmax(0,1fr)]">
      <!-- left: settings -->
      <TabsRoot v-model="tab" class="card flex min-h-0 flex-col">
        <TabsList
          class="flex items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800"
        >
          <TabsTrigger
            v-for="t in ['metadata', 'chapters', 'options']"
            :key="t"
            :value="t"
            class="border-b-2 border-transparent px-3 py-2 text-sm capitalize text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-100"
            >{{ t }}</TabsTrigger
          >
        </TabsList>
        <div class="min-h-0 flex-1 overflow-auto p-5">
          <!-- metadata -->
          <TabsContent value="metadata" class="space-y-4">
            <div class="grid gap-3 text-sm sm:grid-cols-2">
              <label>Title<input v-model="meta.title" class="input mt-1 w-full" /></label>
              <label
                >Series <span class="text-zinc-400">(novel)</span
                ><input v-model="meta.series" class="input mt-1 w-full"
              /></label>
              <label>Author<input v-model="meta.author" class="input mt-1 w-full" /></label>
              <label
                >Narrator credit<input v-model="meta.narrator" class="input mt-1 w-full"
              /></label>
              <label
                >Year<input v-model.number="meta.year" type="number" class="input mt-1 w-full"
              /></label>
              <label
                >Filename
                <div class="input mt-1 flex w-full items-center gap-1 py-0">
                  <input
                    v-model="meta.filename"
                    class="min-w-0 flex-1 bg-transparent py-1 focus:outline-none"
                  /><span class="text-zinc-400">{{
                    meta.splitPerVolume ? " - Vol. N.m4b" : ".m4b"
                  }}</span>
                </div></label
              >
              <label class="sm:col-span-2"
                >Description<textarea
                  v-model="meta.description"
                  rows="2"
                  class="input mt-1 w-full"
                  placeholder="Shown in audiobook players. Leave blank to use the EPUB blurb."
                ></textarea>
              </label>
            </div>

            <div
              v-if="multi"
              class="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
            >
              <UiSwitch v-model="meta.splitPerVolume" class="items-start"
                ><span class="text-sm"
                  ><b>One file per volume</b><br /><span class="text-xs text-zinc-500"
                    >Each M4B gets series = “{{ meta.series }}”, volume N of
                    {{ book.volumes.length }}, and the volume name as subtitle. Players group them
                    as a series.</span
                  ></span
                ></UiSwitch
              >
            </div>

            <div class="flex items-center gap-4">
              <img
                v-if="meta.cover"
                :src="meta.cover"
                class="h-24 w-16 shrink-0 rounded-md object-cover"
                alt="cover"
              />
              <div
                v-else
                class="h-24 w-16 shrink-0 rounded-md"
                :style="{
                  background: `linear-gradient(160deg, ${book.cover[0]}, ${book.cover[1]})`,
                }"
              ></div>
              <div class="text-sm">
                <div class="font-medium">Cover</div>
                <div class="text-xs text-zinc-500">
                  {{
                    meta.cover
                      ? "Your image, embedded in every file."
                      : "From the EPUB, embedded in every file."
                  }}
                </div>
                <div class="mt-2 flex gap-1">
                  <label class="btn-ghost btn-xs cursor-pointer"
                    >{{ meta.cover ? "Replace…" : "Use my own…"
                    }}<input
                      type="file"
                      accept="image/*"
                      class="hidden"
                      @change="pickCover" /></label
                  ><button v-if="meta.cover" class="btn-ghost btn-xs" @click="meta.cover = null">
                    Back to EPUB cover
                  </button>
                </div>
              </div>
            </div>
          </TabsContent>

          <!-- chapters -->
          <TabsContent value="chapters">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div class="label">Chapter markers in the file</div>
              <div class="flex flex-wrap items-center gap-3 text-xs">
                <UiSwitch v-model="meta.markers" label="write markers" class="text-zinc-500" />
                <UiSelect
                  v-model="meta.markerPattern"
                  :options="PATTERNS"
                  size="xs"
                  class="w-52"
                  :disabled="!meta.markers"
                />
                <UiSwitch
                  v-if="multi && !meta.splitPerVolume"
                  v-model="meta.volPrefix"
                  label="prefix with volume"
                  class="text-zinc-500"
                />
              </div>
            </div>
            <div
              v-if="!meta.markers"
              class="mb-2 rounded-md bg-amber-400/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
            >
              Without markers the player shows one long track — listeners can’t skip by chapter.
            </div>
            <div
              v-else
              class="mb-2 rounded-md bg-zinc-50 px-2 py-1.5 font-mono text-[11px] text-zinc-500 dark:bg-zinc-800/60"
            >
              as the player will list them:
              <span
                v-for="(c, i) in selChapters.slice(0, 3)"
                :key="c.id"
                class="mr-3 text-zinc-800 dark:text-zinc-200"
                >{{ marker(c, i) }}</span
              ><span v-if="selChapters.length > 3">…</span>
            </div>
            <div class="rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
              <div
                v-for="c in selChapters"
                :key="c.id"
                class="flex items-center gap-2 border-b border-zinc-100 px-2 py-1 last:border-0 dark:border-zinc-800"
              >
                <span class="font-mono text-[11px] text-zinc-400">{{
                  String(c.id).padStart(2, "0")
                }}</span>
                <span
                  v-if="multi && meta.volPrefix && !meta.splitPerVolume"
                  class="shrink-0 text-xs text-zinc-400"
                  >{{ shortVol(volName(c)) }} ·</span
                >
                <input v-model="c.title" class="flex-1 bg-transparent focus:outline-none" />
                <span class="font-mono text-[11px] text-zinc-400">{{ fmt(c.duration) }}</span>
              </div>
              <div v-if="!selChapters.length" class="p-3 text-zinc-500">No chapters selected.</div>
            </div>
          </TabsContent>

          <!-- options -->
          <TabsContent value="options" class="grid gap-3 text-sm sm:grid-cols-3">
            <label
              >Format<UiSelect
                model-value="m4b"
                :options="[
                  { value: 'm4b', label: 'M4B (AAC)' },
                  { value: 'mp3', label: 'MP3 (soon)', disabled: true },
                ]"
                class="mt-1"
                block
            /></label>
            <label
              >Bitrate<UiSelect
                v-model="meta.bitrate"
                :options="[
                  { value: 64, label: '64 kbps' },
                  { value: 96, label: '96 kbps' },
                  { value: 128, label: '128 kbps' },
                ]"
                class="mt-1"
                block
            /></label>
            <div></div>
            <label
              >Gap between segments (s)<input
                v-model.number="meta.gapSeg"
                type="number"
                step="0.05"
                class="input mt-1 w-full"
            /></label>
            <label
              >Gap between chapters (s)<input
                v-model.number="meta.gapCh"
                type="number"
                step="0.5"
                class="input mt-1 w-full"
            /></label>
          </TabsContent>
        </div>

        <!-- build plan -->
        <div class="border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <div class="label mb-1.5">
            Will build {{ plan.length }} file{{ plan.length === 1 ? "" : "s" }}
          </div>
          <div
            v-if="staleSelected"
            class="mb-2 rounded-md bg-amber-400/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
          >
            ⚠ {{ staleSelected }} selected chapter{{ staleSelected > 1 ? "s have" : " has" }} stale
            audio (edited after narration).
            <RouterLink :to="`/book/${bookId}/narration`" class="underline"
              >Re-narrate first</RouterLink
            >
            or the old audio is used.
          </div>
          <div v-for="p in plan" :key="p.filename" class="flex items-center gap-2 py-1 text-sm">
            <span class="text-zinc-400">⤓</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ p.filename }}</span>
            <span
              v-if="p.volume"
              class="rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-500 dark:bg-zinc-800"
              >vol {{ p.volume.number }}/{{ p.volume.of }}</span
            >
            <span class="font-mono text-[11px] text-zinc-500"
              >{{ p.chapters.length }} ch ·
              {{ fmt(p.chapters.reduce((a, c) => a + c.duration, 0)) }} · ~{{
                estSize(p.chapters.reduce((a, c) => a + c.duration, 0))
              }}
              MB</span
            >
            <span
              v-if="existing(p.filename)"
              class="rounded bg-amber-400/20 px-1.5 text-[10px] font-semibold text-amber-600"
              :title="`Replaces v${existing(p.filename).version} from ${existing(p.filename).createdAt}`"
              >replaces v{{ existing(p.filename).version }}</span
            >
            <span
              v-else
              class="rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-600"
              >new</span
            >
          </div>
          <div v-if="!plan.length" class="text-sm text-zinc-500">
            Select narrated chapters on the left.
          </div>
          <div v-else class="mt-1 text-[11px] text-zinc-400">
            {{ meta.markers ? `${selChapters.length} chapter markers` : "no chapter markers" }} ·
            {{ meta.cover ? "custom cover" : "EPUB cover" }} · {{ meta.bitrate }} kbps AAC
          </div>
        </div>
      </TabsRoot>

      <!-- right: exports -->
      <div class="card min-h-0 overflow-auto p-4">
        <div class="label mb-2">Audiobooks</div>
        <div v-if="!exportsHere.length" class="text-sm text-zinc-500">None yet.</div>
        <div
          v-for="e in exportsHere"
          :key="e.id"
          class="mb-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
        >
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate font-mono text-xs">{{ e.filename }}</div>
              <div class="mt-0.5 text-xs text-zinc-500">
                <span v-if="e.volume"
                  >{{ e.series }} · vol {{ e.volume.number }}/{{ e.volume.of }} · </span
                >{{ e.chapters }} ch · {{ fmt(e.duration) }} · {{ e.bitrate }} kbps
              </div>
            </div>
            <span
              class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800"
              >v{{ e.version }}</span
            >
          </div>
          <div
            v-if="e.status === 'building'"
            class="mt-2 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800"
          >
            <div
              class="h-1.5 rounded bg-violet-500 transition-all"
              :style="{ width: e.progress + '%' }"
            ></div>
          </div>
          <template v-else>
            <div
              v-if="app.newSince(e).length"
              class="mt-2 flex items-center gap-2 rounded-md bg-violet-50 px-2 py-1.5 text-xs dark:bg-violet-500/10"
            >
              <span class="min-w-0 flex-1 text-violet-700 dark:text-violet-300"
                ><b
                  >{{ app.newSince(e).length }} new chapter{{
                    app.newSince(e).length > 1 ? "s" : ""
                  }}</b
                >
                narrated since this build</span
              >
              <button class="btn-primary btn-xs whitespace-nowrap" @click="rebuild(e)">
                Rebuild → v{{ e.version + 1 }}
              </button>
            </div>
            <div
              class="mt-2 flex items-center gap-1 rounded bg-zinc-50 px-2 py-1 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800/60"
            >
              <span class="min-w-0 flex-1 truncate" :title="pathOf(e)">{{ pathOf(e) }}</span
              ><button class="shrink-0 text-violet-500 hover:underline" @click="copyPath(e)">
                copy
              </button>
            </div>
            <div class="mt-2 flex items-center gap-2 text-xs text-zinc-500">
              <span>{{ e.size }} MB · {{ e.createdAt }}</span>
              <span class="ml-auto flex gap-1">
                <button
                  class="btn-ghost btn-xs"
                  title="listen (prototype player)"
                  @click="play('exp' + e.id, e.duration)"
                >
                  {{ player.id === "exp" + e.id && player.playing ? "❚❚" : "▶" }}
                </button>
                <button class="btn-ghost btn-xs" title="download" @click="download(e)">⤓</button>
                <button
                  v-if="olderOf(e).length"
                  class="btn-ghost btn-xs"
                  @click="
                    showOld = new Set(
                      showOld.has(e.id)
                        ? [...showOld].filter((x) => x !== e.id)
                        : [...showOld, e.id],
                    )
                  "
                >
                  {{ olderOf(e).length }} older
                </button>
                <button class="btn-ghost btn-xs text-red-500" @click="app.deleteExport(e.id)">
                  ✕
                </button>
              </span>
            </div>
            <div
              v-if="player.id === 'exp' + e.id"
              class="mt-2 h-1 rounded bg-zinc-200 dark:bg-zinc-800"
            >
              <div
                class="h-1 rounded bg-violet-500"
                :style="{ width: (player.len ? (player.pos / player.len) * 100 : 0) + '%' }"
              ></div>
            </div>
            <div
              v-if="showOld.has(e.id)"
              class="mt-2 space-y-1 border-t border-dashed border-zinc-200 pt-2 dark:border-zinc-800"
            >
              <div
                v-for="o in olderOf(e)"
                :key="o.id"
                class="flex items-center gap-2 text-[11px] text-zinc-400"
              >
                <span class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">v{{ o.version }}</span
                ><span>{{ o.chapters }} ch · {{ o.size }} MB · {{ o.createdAt }}</span
                ><span class="ml-auto">replaced</span>
              </div>
            </div>
          </template>
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-zinc-400">
          Building with a filename that already exists replaces that audiobook and bumps its
          version. Older versions stay listed until deleted.
        </p>
      </div>
    </div>
  </div>
</template>
