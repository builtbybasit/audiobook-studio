<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptsStore } from "@/stores/scripts";

// Routing, not configuration: where this book's lines go, and what would stop them getting there.
//
// Endpoints are app-wide — one pool, shared by every book — so they are configured in one place,
// on /endpoints. This panel used to be a second editor for the same objects, with its own copies
// of the same fields and its own idea of what a legal concurrency was; two editors for one object
// is how a book quietly ends up pointed at a different provider than the one you were looking at.
// What is left is the half that is genuinely per book: which endpoint each speaker resolves to,
// and which of them can't currently render.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { keyring } from "@/lib/keyring";
import {
  ArrowUpRight as ArrowIcon,
  Server as EndpointIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import { DOT, TEXT } from "@/lib/endpoints";
import type { HealthTone } from "@/lib/endpoints";
import type { Endpoint } from "@/types";

const props = defineProps<{ bookId: string }>();
/** "assign a voice" belongs to the Voices tab next door, not to a second picker in here. */
const emit = defineEmits<{ voices: [] }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const scriptsStore = useScriptsStore();

const now = ref(Date.now());
let clock: ReturnType<typeof setInterval>;
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => clearInterval(clock));

/** Deep link to the one page that edits endpoints, landing on the tab that fixes this. */
const settingsLink = (e: Endpoint, tab = "overview") =>
  `/endpoints?endpoint=tts:${e.id}&tab=${tab}`;

interface Status {
  label: string;
  tone: HealthTone;
  /** what to do about it, and which tab does it — empty when nothing is wrong */
  fix: string;
  tab: string;
}

/** Only the states that decide whether this book's lines can render. Observed health — latency,
 *  error rates, spend — is the app-wide page's job, and is a click away. */
function statusOf(e: Endpoint): Status {
  const cooling = Math.ceil((e.backoffUntil - now.value) / 1000);
  if (!e.enabled)
    return {
      label: "Paused",
      tone: "muted",
      fix: "Lines routed here wait instead of going out. Resume it to narrate them.",
      tab: "overview",
    };
  if (e.needsKey && !keyring.has(e.id))
    return {
      label: "No API key",
      tone: "warn",
      fix: "This endpoint needs a key. Lines routed here fail until one is set.",
      tab: "connection",
    };
  if (!e.voices.length)
    return {
      label: "No voices",
      tone: "warn",
      fix: "Nothing can be routed here until it has at least one voice.",
      tab: "voices",
    };
  if (cooling > 0)
    return {
      label: `Cooling down ${cooling}s`,
      tone: "warn",
      fix: "The provider rate limited us. Dispatch resumes on its own.",
      tab: "overview",
    };
  return { label: "Ready", tone: "good", fix: "", tab: "overview" };
}

interface Route {
  endpoint: Endpoint;
  lines: number;
  speakers: { name: string; lines: number; own: boolean; voice: string }[];
}

const counts = computed(() => scriptsStore.lineCounts(props.bookId));
const linesOf = (name: string) => counts.value[name] ?? 0;

/** Every speaker resolved the way narration resolves it — a speaker with no voice of its own is
 *  read in the Narrator's, and lands on the Narrator's endpoint. */
const resolved = computed(() => {
  const routes: Route[] = [];
  const unvoiced: { name: string; lines: number }[] = [];
  const dangling: { name: string; lines: number }[] = [];
  for (const c of castStore.charactersOf(props.bookId)) {
    const v = castStore.effectiveVoice(props.bookId, c.name);
    const lines = linesOf(c.name);
    if (!v.endpoint) {
      if (v.ref) dangling.push({ name: c.name, lines });
      else unvoiced.push({ name: c.name, lines });
      continue;
    }
    let row = routes.find((r) => r.endpoint!.id === v.endpoint!.id);
    if (!row) routes.push((row = { endpoint: v.endpoint, lines: 0, speakers: [] }));
    row.lines += lines;
    row.speakers.push({ name: c.name, lines, own: v.own, voice: v.label ?? "" });
  }
  for (const r of routes) r.speakers.sort((a, b) => b.lines - a.lines);
  routes.sort((a, b) => b.lines - a.lines);
  return {
    routes,
    unvoiced: unvoiced.sort((a, b) => b.lines - a.lines),
    dangling: dangling.sort((a, b) => b.lines - a.lines),
  };
});

/** Endpoints in the pool that nothing in this book reaches — listed so the pool is never a
 *  mystery, but kept out of the way. */
const unused = computed(() =>
  endpointsStore.endpoints.filter(
    (e) => !resolved.value.routes.some((r) => r.endpoint.id === e.id),
  ),
);
const blocked = computed(() => resolved.value.routes.filter((r) => statusOf(r.endpoint).fix));
</script>

<template>
  <div class="space-y-3 p-3 text-sm">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span class="label">Routing</span>
      <span class="text-[11px] text-zinc-500"
        >Where this book’s lines go. Endpoints are shared by every book and are set up in one
        place.</span
      >
      <RouterLink
        to="/endpoints"
        class="btn-ghost btn-xs ml-auto"
        title="health, spend, voices and request history for every endpoint"
        >Manage endpoints <ArrowIcon class="icon-sm"
      /></RouterLink>
    </div>

    <div
      v-if="!endpointsStore.endpoints.length"
      class="grid place-items-center rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700"
    >
      <EndpointIcon class="mb-2 h-7 w-7 text-zinc-400" />
      <p class="text-sm text-zinc-500">No speech endpoint is configured.</p>
      <p class="mt-1 max-w-sm text-[11px] leading-relaxed text-zinc-500">
        Narration needs a server to render a line and a voice to render it in. Both are set up on
        the Endpoints page, once, for every book.
      </p>
      <RouterLink to="/endpoints" class="btn-primary btn-xs mt-3"
        >Set up an endpoint <ArrowIcon class="icon-sm"
      /></RouterLink>
    </div>

    <template v-else>
      <p
        v-if="blocked.length"
        class="rounded-md border border-amber-400 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
        role="status"
      >
        <WarnIcon class="icon-sm" />
        {{ blocked.length }} of {{ resolved.routes.length }} endpoint{{
          resolved.routes.length === 1 ? "" : "s"
        }}
        this book uses can’t render right now —
        {{
          blocked
            .map((r) => `${r.endpoint.name} (${statusOf(r.endpoint).label.toLowerCase()})`)
            .join(", ")
        }}.
      </p>

      <!-- one row per endpoint this book reaches -->
      <div
        v-for="r in resolved.routes"
        :key="r.endpoint.id"
        class="rounded-lg border p-3"
        :class="
          statusOf(r.endpoint).fix
            ? 'border-amber-300 dark:border-amber-500/40'
            : 'border-zinc-200 dark:border-zinc-800'
        "
      >
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :class="DOT[statusOf(r.endpoint).tone]"
          ></span>
          <b class="min-w-0 truncate">{{ r.endpoint.name }}</b>
          <span class="text-[11px]" :class="TEXT[statusOf(r.endpoint).tone]">{{
            statusOf(r.endpoint).label
          }}</span>
          <span class="text-[11px] text-zinc-500"
            >· {{ r.speakers.length }} speaker{{ r.speakers.length === 1 ? "" : "s" }} ·
            {{ r.lines.toLocaleString() }} line{{ r.lines === 1 ? "" : "s" }}</span
          >
          <RouterLink
            :to="settingsLink(r.endpoint, statusOf(r.endpoint).tab)"
            class="ml-auto shrink-0 text-[11px] text-violet-600 hover:underline dark:text-violet-400"
            >{{ statusOf(r.endpoint).fix ? "Fix on Endpoints" : "Settings" }}
            <ArrowIcon class="icon-sm"
          /></RouterLink>
        </div>

        <p
          v-if="statusOf(r.endpoint).fix"
          class="mt-1 text-[11px] text-amber-700 dark:text-amber-400"
        >
          {{ statusOf(r.endpoint).fix }}
        </p>

        <p class="mt-1 font-mono text-[11px] text-zinc-500">
          {{ r.endpoint.model || "model required" }} · {{ r.endpoint.concurrency }} at a time ·
          {{ r.endpoint.maxChars ? `≤${r.endpoint.maxChars.toLocaleString()} chars` : "whole lines"
          }}<span v-if="r.endpoint.voices.length">
            · {{ r.endpoint.voices.length }} voice{{
              r.endpoint.voices.length === 1 ? "" : "s"
            }}</span
          >
        </p>

        <div class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="s in r.speakers.slice(0, 12)"
            :key="s.name"
            class="inline-flex items-center gap-1 rounded-full border border-zinc-200 py-0.5 pl-2 pr-1.5 text-[11px] dark:border-zinc-700"
            :title="`${s.name} → ${s.voice}${s.own ? '' : ' (the Narrator’s voice)'} · ${s.lines} lines`"
          >
            <span :class="!s.own && 'text-zinc-400'">{{ s.name }}</span>
            <span class="text-zinc-400">{{ s.voice }}</span>
            <span class="font-mono text-[9px] text-zinc-400">{{ s.lines }}</span>
          </span>
          <span v-if="r.speakers.length > 12" class="self-center text-[11px] text-zinc-500"
            >+{{ r.speakers.length - 12 }} more</span
          >
        </div>
      </div>

      <!-- speakers that reach no endpoint at all -->
      <div
        v-if="resolved.dangling.length || resolved.unvoiced.length"
        class="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="h-2 w-2 shrink-0 rounded-full bg-zinc-400"></span>
          <b class="text-[13px]">Not routed</b>
          <button
            class="ml-auto text-[11px] text-violet-600 hover:underline dark:text-violet-400"
            @click="emit('voices')"
          >
            Assign voices
          </button>
        </div>
        <p
          v-if="resolved.dangling.length"
          class="mt-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400"
        >
          <WarnIcon class="icon-sm" />
          {{ resolved.dangling.length }} speaker{{
            resolved.dangling.length === 1 ? "" : "s"
          }}
          point at a voice that no longer exists ({{
            resolved.dangling
              .slice(0, 4)
              .map((d) => d.name)
              .join(", ")
          }}{{ resolved.dangling.length > 4 ? ", …" : "" }}). Pick another voice, or add that id
          back on the endpoint that had it.
        </p>
        <p v-if="resolved.unvoiced.length" class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
          {{ resolved.unvoiced.length }} speaker{{ resolved.unvoiced.length === 1 ? "" : "s" }} have
          no voice and no Narrator to borrow from — assign the Narrator’s voice first and the rest
          follow it.
        </p>
      </div>

      <p v-if="unused.length" class="text-[11px] leading-relaxed text-zinc-500">
        Also in the pool, unused by this book:
        <template v-for="(e, i) in unused" :key="e.id"
          ><RouterLink :to="settingsLink(e)" class="hover:text-violet-500">{{ e.name }}</RouterLink
          >{{ i < unused.length - 1 ? ", " : "" }}</template
        >. Pausing one of those changes nothing here.
      </p>
    </template>
  </div>
</template>
