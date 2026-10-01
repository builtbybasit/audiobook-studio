<script setup lang="ts">
import { useUiStore } from "@/stores/ui";
import { plural } from "@/lib/contents";

// Three things get confused with each other and are kept apart here:
//
//   the saved model configuration — this row, its name, its model id, its limits and prices
//   the provider connection      — base URL + credential, which several configurations may share
//   the quota group              — whose rate limit and spend pool this configuration draws on
//
// Renaming a configuration is harmless. Changing its base URL, model or credential points it at a
// different provider, so edits are staged and applied deliberately, and when work is in flight the
// Save button says what will and won't move.
import { computed, ref, watch } from "vue";
import { keyInPlace } from "@/services/endpointSettings";
import ServerKeyField from "@/views/endpoints/ServerKeyField.vue";
import { UiHint, UiSelect, UiSwitch, UiTooltip } from "@/ui";
import {
  Check as OkIcon,
  Plus as AddIcon,
  TriangleAlert as WarnIcon,
  Zap as TestIcon,
} from "@lucide/vue";
import {
  KIND_LABEL,
  KIND_PATH,
  endpointErrors,
  opsOf,
  relative,
  ttsRequestPath,
} from "@/lib/endpoints";
import { maybeMoney } from "@/lib/pricing";
import { isSimulated } from "@/lib/providers";
import { encodingSummary } from "@/lib/audioFormat";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import { useEndpointsStore } from "@/stores/endpoints";
import {
  PROVIDER_FIELDS,
  applyDraft,
  discardDraft,
  draftChanges,
  draftFor,
  stagePreset,
  ui,
} from "@/views/endpoints/state";
import { usePresetPicker } from "@/composables/usePresetPicker";
import type { ConnectionTest } from "@/types";

const props = defineProps<{
  u: UnifiedEndpoint;
  /** every endpoint on the page, for "who else shares this connection" */
  all: UnifiedEndpoint[];
  /** unfinished jobs that would go through this endpoint */
  busy: number;
  testing: boolean;
  /** what a probe would cost at the rates as configured; null when the rate is unknown */
  probeCost: number | null;
}>();
const emit = defineEmits<{ test: []; remove: [] }>();

const uiStore = useUiStore();
const draft = computed(() => draftFor(props.u));
const changes = computed(() => draftChanges(props.u));
const providerChanged = computed(() => changes.value.some((c) => PROVIDER_FIELDS.includes(c)));
const confirming = ref(false);
const errors = computed(() => endpointErrors(props.u));
const test = computed<ConnectionTest | undefined>(() => ui.tests[props.u.key]);
const now = Date.now();
/**
 * The server keeps one key per endpoint and nothing per named credential, so the key field is
 * always this endpoint's own and goes to the server; a credential only names the account.
 */
const endpointsStore = useEndpointsStore();
const CRED_OPTIONS = computed(() => [
  { value: "__own__", label: "This endpoint’s own key", hint: "kept on the server" },
  ...endpointsStore.credentials.map((c) => ({ value: c.id, label: c.label, hint: "" })),
]);

const credential = computed({
  get: () => draft.value.credentialId ?? "__own__",
  set: (v: string | number | null) => {
    draft.value.credentialId = v === "__own__" || v == null ? null : String(v);
  },
});

/** Other saved configurations pointing at the same base URL + credential. */
const sameConnection = computed(() =>
  props.all.filter(
    (x) =>
      x.key !== props.u.key &&
      x.baseUrl.replace(/\/$/, "") === props.u.baseUrl.replace(/\/$/, "") &&
      (opsOf(x).credentialId ?? null) === (opsOf(props.u).credentialId ?? null),
  ),
);
const group = computed(() => opsOf(props.u).quotaGroup);
const sameQuota = computed(() =>
  group.value
    ? props.all.filter((x) => x.key !== props.u.key && opsOf(x).quotaGroup === group.value)
    : [],
);

const keyHeld = computed(() => keyInPlace(props.u.profile ?? props.u.endpoint));

function save() {
  if (providerChanged.value && props.busy && !confirming.value) {
    confirming.value = true;
    return;
  }
  const name = draft.value.name.trim() || props.u.name;
  const rerouted = providerChanged.value;
  const preset = draft.value.preset?.label;
  const repaired = applyDraft(props.u);
  confirming.value = false;
  uiStore.toast(`${name} connection saved`, {
    kind: "success",
    description: rerouted
      ? "New jobs use it from now on. Jobs already queued keep the connection they were created with."
      : preset
        ? `Nothing was re-routed. ${preset}’s prices and limits apply from the next request.`
        : "Nothing was re-routed — only this configuration’s labels changed.",
  });
  // A new base URL can speak an API without the format or rate this endpoint was set to; what was
  // put back is said on its own, so it is not lost inside the saved message.
  if (repaired.length)
    uiStore.toast("Audio format adjusted for the new API", {
      kind: "warn",
      description: repaired.join(" ") + " See the Requests tab.",
    });
}
function discard() {
  discardDraft(props.u);
  confirming.value = false;
}
// ---------- presets ----------
// A preset is staged like any other edit: the connection half fills the form, and the rest —
// billing or token prices, limits, concurrency — waits in the same draft, so Save applies all of it
// and Discard drops all of it. This tab is not remounted per endpoint, so the chosen preset and its
// note are forgotten when another endpoint is selected.
const {
  options: presetOptions,
  presetId,
  note: presetNote,
  choose: choosePreset,
} = usePresetPicker({
  kind: () => props.u.kind,
  endpoint: () => props.u.key,
  fill: (fields, preset) => stagePreset(props.u, preset.label, fields),
  next: "Review it below, then Save — its prices and limits go on with it. Discard puts everything back.",
});
/** A `simulated:` base URL is answered by the server itself: there is no request line, no key and
 *  no account, so the form says that instead of asking for them. */
const simulated = computed(() => isSimulated(draft.value.baseUrl));
// Typing a simulated base URL over a hosted one stages "needs no key" with it, so the endpoint is
// not left waiting on a key it will never be asked for. Selecting another endpoint changes nothing.
watch([() => props.u.key, simulated], ([key, now], [was]) => {
  if (key === was && now) draft.value.needsKey = false;
});
/** Where a request actually goes. Fish Audio serves /tts, not the OpenAI-style /audio/speech, so
 *  this follows the draft and updates the moment a preset or a hand-typed base URL changes it. */
const path = computed(() =>
  simulated.value
    ? ""
    : props.u.kind === "tts"
      ? ttsRequestPath(draft.value)
      : KIND_PATH[props.u.kind],
);
/** The staged changes as the banner lists them; a preset's prices and limits are one of them. */
const changeList = computed(() =>
  changes.value
    .map((c) => (c === "preset" ? `prices and limits from ${draft.value.preset?.label}` : c))
    .join(", "),
);

function newCredential() {
  const id = endpointsStore.addCredential(draft.value.name || "New credential");
  draft.value.credentialId = id;
}
</script>

<template>
  <div class="space-y-3">
    <!-- staged edits -->
    <div
      v-if="changes.length"
      class="rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs dark:border-violet-500/50 dark:bg-violet-500/10"
      role="status"
    >
      <div class="flex flex-wrap items-center gap-2">
        <b class="text-violet-700 dark:text-violet-300">Unsaved changes</b>
        <span class="text-zinc-600 dark:text-zinc-300"
          >{{ changeList }} — nothing is using these yet.</span
        >
        <span class="ml-auto flex gap-2">
          <button class="btn-ghost btn-xs" @click="discard">Discard</button>
          <button class="btn-primary btn-xs" @click="save">
            {{ confirming ? "Yes, apply to new jobs" : "Save connection" }}
          </button>
        </span>
      </div>
      <p
        v-if="confirming"
        class="mt-2 rounded bg-white/70 p-2 leading-relaxed text-zinc-600 dark:bg-zinc-900/60 dark:text-zinc-300"
      >
        <WarnIcon class="icon-sm text-amber-500" />
        {{ plural(busy, "job") }} on this endpoint {{ busy === 1 ? "is" : "are" }} unfinished and
        {{ busy === 1 ? "keeps" : "keep" }} the base URL, model and credential they were queued
        with. This change applies to jobs started after you save.
      </p>
    </div>

    <section class="card p-3">
      <h3 class="label mb-2">
        Provider
        <UiHint
          label="presets"
          :text="`A preset fills in the base URL, model and ${u.kind === 'scripting' ? 'token prices' : 'billing'}; every field stays editable.`"
        />
      </h3>
      <div class="flex flex-wrap items-center gap-2">
        <UiSelect
          :model-value="presetId"
          :options="presetOptions"
          class="w-72"
          aria-label="Start from a provider preset"
          @update:model-value="choosePreset"
        />
        <UiHint v-if="presetNote" label="the preset chosen" side="bottom" :text="presetNote" />
      </div>
    </section>

    <div class="grid gap-3 lg:grid-cols-2">
      <!-- the saved configuration -->
      <section class="card p-3">
        <h3 class="label mb-2">This model configuration</h3>
        <div class="space-y-2.5">
          <label class="block space-y-1 text-xs font-medium"
            ><span>Name</span
            ><input
              v-model="draft.name"
              class="input w-full"
              placeholder="OpenAI (main)"
              :aria-describedby="`${u.key}-name-hint`"
            />
            <span :id="`${u.key}-name-hint`" class="block text-[11px] font-normal text-zinc-500"
              >Yours, not the provider’s. Two configurations may share one connection.</span
            ></label
          >
          <div class="flex items-center justify-between gap-3 text-xs">
            <span class="font-medium"
              >Endpoint type
              <UiHint
                label="endpoint type"
                :text="`Fixed: ${u.kind === 'scripting' ? 'scripting' : 'speech'} endpoints are picked by ${u.kind === 'scripting' ? 'a run' : 'a voice'}, so the type can’t change in place.`"
            /></span>
            <span class="chip chip-on">{{ KIND_LABEL[u.kind] }}</span>
          </div>
          <label class="block space-y-1 text-xs font-medium"
            ><span>Model ID</span
            ><input
              v-model="draft.model"
              class="input w-full font-mono"
              spellcheck="false"
              :placeholder="u.kind === 'scripting' ? 'gpt-4o-mini' : 'tts-1-hd'"
          /></label>
        </div>
      </section>

      <!-- the provider connection -->
      <section class="card p-3">
        <h3 class="label mb-2">Provider connection</h3>
        <div class="space-y-2.5">
          <div class="space-y-1 text-xs font-medium">
            <span
              ><span :id="`${u.key}-url-label`">Base URL</span>
              <UiHint label="the base URL"
                >Any OpenAI-compatible server; include <code class="font-mono">/v1</code> only if
                the provider needs it.</UiHint
              ></span
            >
            <input
              v-model.trim="draft.baseUrl"
              type="url"
              class="input w-full font-mono"
              spellcheck="false"
              placeholder="https://your-provider.com/v1"
              :aria-labelledby="`${u.key}-url-label`"
            />
            <span v-if="simulated" class="block text-[11px] font-normal text-zinc-500"
              >Simulated — answered by this server; no key, no cost.</span
            >
            <span v-else class="block text-[11px] font-normal text-zinc-500"
              >Requests append <code class="font-mono">{{ path }}</code></span
            >
          </div>

          <template v-if="!simulated">
            <div class="space-y-1 text-xs font-medium">
              <span
                ><span id="cred-label">Credential</span>
                <UiHint
                  label="credentials"
                  text="Names the account this endpoint uses; the server still keeps one key per endpoint, saved below."
              /></span>
              <div class="flex items-center gap-2">
                <UiSelect
                  v-model="credential"
                  :options="CRED_OPTIONS"
                  size="xs"
                  class="min-w-0 flex-1"
                  aria-labelledby="cred-label"
                />
                <button class="btn-ghost btn-xs shrink-0" type="button" @click="newCredential">
                  <AddIcon class="icon-sm" /> New
                </button>
              </div>
            </div>

            <ServerKeyField
              :kind="u.kind"
              :id="u.id"
              :name="u.name"
              :has-key="keyHeld"
              :needs-key="draft.needsKey"
            />
            <UiSwitch v-model="draft.needsKey" label="This endpoint requires a key" />
          </template>
        </div>
      </section>
    </div>

    <!-- quota group + who shares what -->
    <section class="card p-3">
      <h3 class="label mb-2">
        Shared quota group
        <UiHint
          label="quota groups"
          text="Endpoints in one group share a provider account: a rate limit on one backs the others off and their spend adds up. Leave empty for an account of its own."
        />
      </h3>
      <div class="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
        <label class="block space-y-1 text-xs font-medium"
          ><span>Group</span
          ><input
            v-model="draft.quotaGroup"
            class="input w-full"
            list="quota-groups"
            placeholder="none" />
          <datalist id="quota-groups">
            <option
              v-for="g in [...new Set(all.map((x) => opsOf(x).quotaGroup).filter(Boolean))]"
              :key="g!"
              :value="g!"
            ></option></datalist
        ></label>
        <div class="space-y-1.5 self-center text-[11px] text-zinc-600 dark:text-zinc-300">
          <p v-if="sameQuota.length">
            <b>{{ group }}</b> is shared with {{ sameQuota.map((x) => x.name).join(", ") }}.
          </p>
          <p v-if="sameConnection.length">
            The same base URL and credential are also used by
            {{ sameConnection.map((x) => x.name).join(", ") }}.
          </p>
        </div>
      </div>
    </section>

    <!-- connection test -->
    <section class="card p-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="label mb-1">
            Connection test
            <UiHint
              label="the connection test"
              text="One request from the server with the saved settings and key; it touches no book, queues no job and writes nothing to any chapter."
            />
          </h3>
          <p v-if="isSimulated(u.baseUrl)" class="text-[11px] text-zinc-500">
            One simulated answer<template v-if="u.endpoint">
              in <b>{{ encodingSummary(u.endpoint) }}</b></template
            >; nothing reaches the network.
          </p>
          <p v-else class="break-words text-[11px] text-zinc-500">
            One request to
            <code class="font-mono">{{ (u.baseUrl || "…").replace(/\/$/, "") }}{{ path }}</code>
            <template v-if="u.endpoint">
              for <b>{{ encodingSummary(u.endpoint) }}</b></template
            >
            with the key saved on the server.
          </p>
          <p class="mt-1 text-[11px] text-zinc-500">
            {{
              u.kind === "scripting"
                ? "~24 input and 8 output tokens"
                : "12 characters of sample text"
            }}
            · would cost
            <b :class="probeCost == null && 'text-amber-600 dark:text-amber-400'">{{
              maybeMoney(probeCost)
            }}</b>
            at the Pricing tab’s rates.
          </p>
        </div>
        <button
          class="btn-ghost btn-xs shrink-0"
          :disabled="testing || errors.length > 0"
          @click="emit('test')"
        >
          <TestIcon class="icon-sm" /> {{ testing ? "Testing…" : "Run test" }}
        </button>
      </div>
      <p
        v-if="errors.length"
        class="mt-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" /> Fix the settings first: {{ errors[0] }}
      </p>
      <div
        v-else-if="test"
        class="mt-2 rounded-md border px-2.5 py-2 text-[11px]"
        :class="
          test.ok
            ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10'
            : 'border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10'
        "
        role="status"
      >
        <div class="flex flex-wrap items-center gap-2">
          <component
            :is="test.ok ? OkIcon : WarnIcon"
            class="icon-sm"
            :class="test.ok ? 'text-emerald-600' : 'text-red-600'"
          />
          <b>{{ test.message }}</b>
          <span class="text-zinc-500">{{ relative(test.at, now) }}</span>
        </div>
        <p class="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-300">{{ test.detail }}</p>
      </div>
      <p v-else class="mt-2 text-[11px] text-zinc-500">
        Not tested yet — health reads <b>Not tested</b> until something answers.
      </p>
      <p
        v-if="changes.length"
        class="mt-2 rounded bg-violet-50 px-2 py-1 text-[11px] text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
      >
        Tests the saved settings; save the changes above ({{ changeList }}) to include them.
      </p>
    </section>

    <!-- removal -->
    <section class="card border-red-200 p-3 dark:border-red-500/30">
      <h3 class="label mb-1">Remove this endpoint</h3>
      <UiTooltip text="Removal is undoable from the toast that appears." side="top">
        <p class="text-[11px] text-zinc-500">
          <template v-if="busy"
            >Cancel {{ plural(busy, "unfinished job") }} from the header first.</template
          >
          <template v-else-if="u.kind === 'tts'"
            >Speakers whose voice lives here show as unrouted until repicked; rendered clips and
            recorded spend are kept.</template
          >
          <template v-else
            >Past jobs keep the model and prices they ran with; a run needs another endpoint picked
            for it.</template
          >
        </p>
      </UiTooltip>
      <button
        class="btn-ghost btn-xs mt-2 border-red-300 text-red-600 dark:border-red-500/40 dark:text-red-400"
        :disabled="busy > 0"
        @click="emit('remove')"
      >
        Remove {{ u.name }}
      </button>
    </section>
  </div>
</template>
