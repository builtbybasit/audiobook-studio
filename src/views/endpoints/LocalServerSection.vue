<script setup lang="ts">
// A server on this machine the app starts for this endpoint: its fields, staged in the
// connection draft, and, once saved, what it is doing now.
import { computed } from "vue";
import { Play as StartIcon, Square as StopIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { UiHint, UiNumber, UiSwitch } from "@/ui";
import { DOT, TEXT, type UnifiedEndpoint } from "@/lib/endpoints";
import { DEFAULT_READY_SEC, serverKey } from "@/lib/localServers";
import { useLocalServerActions, useLocalServers } from "@/queries/localServers";
import {
  draftChanges,
  draftFor,
  gb,
  launchProblem,
  savedLaunch,
  serverStateOf,
  serverStatusOf,
} from "@/views/endpoints/state";

const props = defineProps<{ u: UnifiedEndpoint }>();

const launch = computed(() => draftFor(props.u).launch);
const problem = computed(() => launchProblem(launch.value));
const saved = computed(() => savedLaunch(props.u));
const unsaved = computed(() => draftChanges(props.u).includes("launch"));

const { data: servers } = useLocalServers();
const { start, stop } = useLocalServerActions();
const key = computed(() => serverKey(props.u.kind, props.u.id));
const status = computed(() => serverStatusOf(servers.value?.servers, props.u));
const shown = computed(() => serverStateOf(status.value));
const pending = computed(
  () => start.asyncStatus.value === "loading" || stop.asyncStatus.value === "loading",
);
const canStart = computed(
  () => !unsaved.value && (status.value.state === "stopped" || status.value.state === "crashed"),
);
// one the app didn't start can still be ended by its stop command
const stoppable = computed(() => status.value.state !== "outside" || !!saved.value?.stopCommand);
const canStop = computed(() =>
  ["queued", "starting", "running", "outside"].includes(status.value.state),
);
</script>

<template>
  <section class="card p-3">
    <h3 class="label mb-2">
      Local server
      <UiHint
        label="local servers"
        text="For a server on this computer: the app starts it when a request needs it and stops it when the app quits. Leave the fields empty for one you run yourself or a hosted provider."
      />
    </h3>
    <div class="grid gap-3 sm:grid-cols-2">
      <div class="space-y-1 text-xs font-medium sm:col-span-2">
        <span
          ><span :id="`${u.key}-dir-label`">Folder</span>
          <UiHint label="the folder" text="Leave it empty to start in your home folder."
        /></span>
        <input
          v-model="launch.dir"
          class="input w-full font-mono"
          spellcheck="false"
          placeholder="C:\servers\breeze"
          :aria-labelledby="`${u.key}-dir-label`"
        />
      </div>
      <div class="space-y-1 text-xs font-medium">
        <span
          ><span :id="`${u.key}-command-label`">Start command</span>
          <UiHint
            label="the start command"
            text="Run in the folder by the system shell (cmd on Windows, sh elsewhere). The app starts it when a request needs it and stops it when the app quits; a server already answering at the base URL is used as it is."
        /></span>
        <input
          v-model="launch.command"
          class="input w-full font-mono"
          spellcheck="false"
          placeholder="./serve.sh --port 8000"
          :aria-labelledby="`${u.key}-command-label`"
        />
      </div>
      <div class="space-y-1 text-xs font-medium">
        <span
          ><span :id="`${u.key}-stop-label`">Stop command</span>
          <UiHint
            label="the stop command"
            text='Optional. Empty: Stop ends the process the app started. For a server in WSL or Docker, killing that process leaves the server running, so name the command that stops it there, such as wsl.exe -e pkill -f "uvicorn main:app" or docker stop phonon.'
        /></span>
        <input
          v-model="launch.stopCommand"
          class="input w-full font-mono"
          spellcheck="false"
          placeholder="docker stop phonon"
          :aria-labelledby="`${u.key}-stop-label`"
        />
      </div>
      <div class="flex items-center gap-1.5 text-xs font-medium">
        <UiSwitch v-model="launch.heavy" label="Heavy" />
        <UiHint
          label="heavy servers"
          text="Heavy servers never run together: starting one stops the other heavy one once it has had nothing to do for a few seconds. Leave it off for one that runs beside anything, such as a CPU server."
        />
      </div>
      <div class="flex items-center justify-between gap-3 text-xs font-medium">
        <span
          >Ready within
          <UiHint
            label="ready within"
            text="How long it may take after starting until GET /health says it is ready (a server without /health: until it answers). Longer than that counts as a failed start."
        /></span>
        <UiNumber
          v-model="launch.readySec"
          class="w-28"
          unit="s"
          :min="1"
          :empty="null"
          :placeholder="String(DEFAULT_READY_SEC)"
          label="Seconds the server may take to answer after starting"
        />
      </div>
    </div>
    <p
      v-if="problem"
      class="mt-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
      role="alert"
    >
      <WarnIcon class="icon-sm" /> {{ problem }}
    </p>

    <div v-if="saved" class="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <div class="flex flex-wrap items-center gap-2 text-xs" role="status">
        <span class="h-2 w-2 shrink-0 rounded-full" :class="DOT[shown.tone]"></span>
        <b :class="TEXT[shown.tone]">{{ shown.label }}</b>
        <span v-if="status.vramMb != null" class="text-zinc-500"
          >≈ {{ gb(status.vramMb) }} GB VRAM</span
        >
        <span v-if="status.waiting || status.active" class="text-zinc-500"
          ><template v-if="status.waiting">{{ status.waiting }} waiting</template
          ><template v-if="status.waiting && status.active"> · </template
          ><template v-if="status.active">{{ status.active }} out</template></span
        >
        <span class="ml-auto flex gap-2">
          <button
            class="btn-ghost btn-xs"
            :disabled="!canStart || pending"
            @click="start.mutate(key)"
          >
            <StartIcon class="icon-sm" /> Start
          </button>
          <button
            v-if="stoppable"
            class="btn-ghost btn-xs"
            :disabled="!canStop || pending"
            @click="stop.mutate(key)"
          >
            <StopIcon class="icon-sm" /> Stop
          </button>
        </span>
      </div>
      <p v-if="unsaved" class="mt-1 text-[11px] text-zinc-500">
        Start uses the saved settings; save the local server changes first.
      </p>
      <details
        v-if="status.output.length"
        class="mt-2 text-[11px]"
        :open="status.state === 'crashed'"
      >
        <summary class="cursor-pointer select-none text-zinc-500">Output</summary>
        <pre
          class="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-2 font-mono text-[11px] leading-snug text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300"
          >{{ status.output.join("\n") }}</pre>
      </details>
    </div>
  </section>
</template>
