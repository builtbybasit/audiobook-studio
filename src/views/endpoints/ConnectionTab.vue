<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";

// Three things get confused with each other and are kept apart here:
//
//   the saved model configuration — this row, its name, its model id, its limits and prices
//   the provider connection      — base URL + credential, which several configurations may share
//   the quota group              — whose rate limit and spend pool this configuration draws on
//
// Renaming a configuration is harmless. Changing its base URL, model or credential points it at a
// different provider, so edits are staged and applied deliberately, and when work is in flight the
// Save button says what will and won't move.
import { computed, ref } from "vue";
import { keyring } from "@/lib/keyring";
import { activeEndpointSettingsService, keyInPlace } from "@/services/endpointSettings";
import ServerKeyField from "@/views/endpoints/ServerKeyField.vue";
import { UiSelect, UiSwitch, UiTooltip } from "@/ui";
import {
  Check as OkIcon,
  Plus as AddIcon,
  TriangleAlert as WarnIcon,
  Zap as TestIcon,
} from "@lucide/vue";
import {
  KIND_LABEL,
  KIND_PATH,
  TTS_PRESETS,
  endpointErrors,
  opsOf,
  presetById,
  relative,
  ttsRequestPath,
} from "@/lib/endpoints";
import { maybeMoney } from "@/lib/pricing";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import {
  addCredential,
  credentialById,
  credentialHasSecret,
  credentialSecret,
  credentials,
  setCredentialSecret,
} from "@/lib/credentials";
import {
  PROVIDER_FIELDS,
  applyDraft,
  discardDraft,
  draftChanges,
  draftFor,
  ui,
} from "@/views/endpoints/state";
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

const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
const draft = computed(() => draftFor(props.u));
const changes = computed(() => draftChanges(props.u));
const providerChanged = computed(() => changes.value.some((c) => PROVIDER_FIELDS.includes(c)));
const confirming = ref(false);
const errors = computed(() => endpointErrors(props.u));
const test = computed<ConnectionTest | undefined>(() => ui.tests[props.u.key]);
const now = Date.now();
/**
 * A server answering keeps one key per endpoint and nothing per named credential, so there the
 * key field is always this endpoint's own and goes to the server; a credential only names the
 * account. The demo keeps keys in the in-memory keyring, credentials included.
 */
const onServer = !!activeEndpointSettingsService();

const CRED_OPTIONS = computed(() => [
  {
    value: "__own__",
    label: "This endpoint’s own key",
    hint: onServer ? "kept on the server" : "typed here, not shared",
  },
  ...credentials.map((c) => ({
    value: c.id,
    label: c.label,
    hint: onServer ? "" : credentialHasSecret(c.id) ? "set" : "empty",
  })),
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

const keyHeld = computed(() => keyInPlace(props.u.profile ?? props.u.endpoint, props.u.slot));
const usingCredential = computed(() => credentialById(opsOf(props.u).credentialId));

function save() {
  if (providerChanged.value && props.busy && !confirming.value) {
    confirming.value = true;
    return;
  }
  const name = draft.value.name.trim() || props.u.name;
  applyDraft(props.u);
  confirming.value = false;
  uiStore.toast(`${name} connection saved`, {
    kind: "success",
    description: providerChanged.value
      ? "New jobs use it from now on. Jobs already queued keep the connection they were created with."
      : "Nothing was re-routed — only this configuration’s labels changed.",
  });
}
function discard() {
  discardDraft(props.u);
  confirming.value = false;
}
// ---------- presets ----------
// A preset fills in what the provider pins down. The connection half (base URL, model, whether a
// key is needed) goes into the draft so it is saved like any other provider change; the rest —
// billing, limits, concurrency — is written straight onto the endpoint, the way the Pricing tab
// writes it, because nothing stages those.
const PRESET_OPTIONS = [
  { value: "", label: "Start from a preset…", hint: "leaves every field as it is" },
  ...TTS_PRESETS.map((p) => ({ value: p.id, label: p.label, hint: p.hint })),
];
const presetId = ref("");
/** Where a request actually goes. Fish Audio serves /tts, not the OpenAI-style /audio/speech, so
 *  this follows the draft and updates the moment a preset or a hand-typed base URL changes it. */
const path = computed(() =>
  props.u.kind === "tts" ? ttsRequestPath(draft.value) : KIND_PATH[props.u.kind],
);
const presetNote = computed(() => (presetId.value ? presetById(presetId.value)?.note : undefined));

function usePreset(id: string | number | null) {
  const preset = presetById(String(id ?? ""));
  presetId.value = preset?.id ?? "";
  if (!preset) return;
  const { name, model, baseUrl, needsKey, ...rest } = preset.apply;
  if (name !== undefined) draft.value.name = name;
  if (model !== undefined) draft.value.model = model;
  if (baseUrl !== undefined) draft.value.baseUrl = baseUrl;
  if (needsKey !== undefined) draft.value.needsKey = needsKey;
  const endpoint = endpointsStore.endpoints.find((e) => e.id === props.u.id);
  if (endpoint) Object.assign(endpoint, rest);
  uiStore.toast(`${preset.label} defaults filled in`, {
    kind: "success",
    description: "Review the connection below, then Save. Nothing is dispatched until you do.",
  });
}

function newCredential() {
  const id = addCredential(draft.value.name || "New credential");
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
          >{{ changes.join(", ") }} — nothing is using these yet.</span
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
        {{ busy }} job{{ busy === 1 ? "" : "s" }} on this endpoint {{ busy === 1 ? "is" : "are" }}
        unfinished. They keep the base URL, model and credential they were queued with — this change
        only applies to jobs started after you save. Nothing is re-sent, and nothing already
        recorded is re-priced.
      </p>
    </div>

    <section v-if="u.kind === 'tts'" class="card p-3">
      <h3 class="label mb-2">Provider</h3>
      <div class="flex flex-wrap items-center gap-2">
        <UiSelect
          :model-value="presetId"
          :options="PRESET_OPTIONS"
          class="w-72"
          aria-label="Start from a provider preset"
          @update:model-value="usePreset"
        />
        <span class="text-[11px] text-zinc-500">
          Fills in the base URL, model and billing. Every field stays editable.
        </span>
      </div>
      <p v-if="presetNote" class="mt-2 text-[11px] leading-relaxed text-zinc-500">
        {{ presetNote }}
      </p>
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
          <div class="flex items-start justify-between gap-3 text-xs">
            <span class="font-medium">Endpoint type</span>
            <span class="text-right">
              <span class="chip chip-on">{{ KIND_LABEL[u.kind] }}</span>
              <span class="mt-1 block text-[11px] text-zinc-500"
                >Fixed — {{ u.kind === "scripting" ? "scripting" : "speech" }} endpoints are picked
                by {{ u.kind === "scripting" ? "a run" : "a voice" }}, so this can’t change in
                place.</span
              >
            </span>
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
          <label class="block space-y-1 text-xs font-medium"
            ><span>Base URL</span
            ><input
              v-model.trim="draft.baseUrl"
              type="url"
              class="input w-full font-mono"
              spellcheck="false"
              placeholder="https://your-provider.com/v1"
            />
            <span class="block text-[11px] font-normal text-zinc-500"
              >Any OpenAI-compatible server. Requests append
              <code class="font-mono">{{ path }}</code
              >; include <code class="font-mono">/v1</code> only if your provider needs it.</span
            ></label
          >

          <div class="space-y-1 text-xs font-medium">
            <span id="cred-label">Credential</span>
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
            <p v-if="onServer" class="text-[11px] font-normal text-zinc-500">
              A named credential says which account this endpoint uses. The server keeps one key per
              endpoint, so each endpoint on the account has its key saved below.
            </p>
            <p v-else class="text-[11px] font-normal text-zinc-500">
              A named credential can be shared by several endpoints; the key itself is kept in
              memory only and never written to a settings export.
            </p>
          </div>

          <ServerKeyField
            v-if="onServer"
            :kind="u.kind"
            :id="u.id"
            :name="u.name"
            :has-key="keyHeld"
            :needs-key="draft.needsKey"
          />
          <label v-else-if="draft.credentialId" class="block space-y-1 text-xs font-medium"
            ><span>{{ credentialById(draft.credentialId)?.label }} key</span
            ><input
              :value="credentialSecret(draft.credentialId)"
              type="password"
              autocomplete="off"
              class="input w-full font-mono"
              placeholder="Paste the API key"
              @input="
                setCredentialSecret(draft.credentialId!, ($event.target as HTMLInputElement).value)
              "
            />
            <span class="block text-[11px] font-normal text-zinc-500"
              >Changing this changes it everywhere the credential is used.</span
            ></label
          >
          <label v-else class="block space-y-1 text-xs font-medium"
            ><span>API key</span
            ><input
              :value="keyring.get(u.slot)"
              type="password"
              autocomplete="off"
              class="input w-full font-mono"
              :placeholder="draft.needsKey ? 'Paste the API key' : 'not required'"
              @input="keyring.set(u.slot, ($event.target as HTMLInputElement).value)"
          /></label>
          <UiSwitch v-model="draft.needsKey" label="This endpoint requires a key" />
          <p
            v-if="!onServer && draft.needsKey && !keyHeld"
            class="rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
          >
            <WarnIcon class="icon-sm" /> No key set — requests routed here fail with a “no API key”
            error until one is added.
          </p>
        </div>
      </section>
    </div>

    <!-- quota group + who shares what -->
    <section class="card p-3">
      <h3 class="label mb-2">Shared quota group</h3>
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
        <div class="text-[11px] leading-relaxed text-zinc-500">
          <p>
            Endpoints in one group draw on the same provider account: a rate limit hit by one backs
            the others off, and their spend adds up against the same quota. Leave it empty when this
            endpoint has an account to itself.
          </p>
          <p v-if="sameQuota.length" class="mt-1.5 text-zinc-600 dark:text-zinc-300">
            <b>{{ group }}</b> is shared with {{ sameQuota.map((x) => x.name).join(", ") }}.
          </p>
          <p v-if="sameConnection.length" class="mt-1.5 text-zinc-600 dark:text-zinc-300">
            The same base URL and credential are also used by
            {{ sameConnection.map((x) => x.name).join(", ") }} — they are separate saved
            configurations, so pausing this one does not pause them.
          </p>
        </div>
      </div>
    </section>

    <!-- connection test -->
    <section class="card p-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="label mb-1">Connection test</h3>
          <p class="break-words text-[11px] leading-relaxed text-zinc-500">
            Sends <b>one</b> request to
            <code class="font-mono">{{ (u.baseUrl || "…").replace(/\/$/, "") }}{{ path }}</code>
            using
            <b v-if="onServer">the key saved on the server</b>
            <b v-else>{{ usingCredential ? usingCredential.label : "this endpoint’s own key" }}</b
            >. It touches no book, queues no job, and writes nothing to any chapter.
          </p>
          <p class="mt-1 text-[11px] text-zinc-500">
            Scope:
            {{
              u.kind === "scripting"
                ? "~24 input and 8 output tokens"
                : "12 characters of sample text"
            }}
            · would cost
            <b :class="probeCost == null && 'text-amber-600 dark:text-amber-400'">{{
              maybeMoney(probeCost)
            }}</b>
            at the rates set on the Pricing tab.
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
          <span v-if="test.simulated" class="chip chip-off">simulated</span>
        </div>
        <p class="mt-1 leading-relaxed text-zinc-600 dark:text-zinc-300">{{ test.detail }}</p>
        <p v-if="!onServer" class="mt-1 text-zinc-500">
          Recorded cost of the probe: {{ maybeMoney(test.cost) }}
          <span v-if="test.cost == null">— no rate is set for this endpoint.</span>
        </p>
      </div>
      <p v-else class="mt-2 text-[11px] text-zinc-500">
        Not tested yet. Until something has answered, this endpoint’s health reads
        <b>Not tested</b> rather than healthy.
      </p>
      <p
        v-if="onServer && changes.length"
        class="mt-2 rounded bg-violet-50 px-2 py-1 text-[11px] text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
      >
        This tests the saved settings. The unsaved changes above ({{ changes.join(", ") }}) are not
        part of it — save them first to test them.
      </p>
      <p
        v-if="onServer"
        class="mt-2 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500 dark:border-zinc-800"
      >
        The server sends this request itself, from the settings and key it has saved, and the
        provider may bill it. A server running the fake provider answers without calling anyone and
        says so.
      </p>
      <p
        v-else
        class="mt-2 border-t border-zinc-100 pt-2 text-[11px] text-zinc-500 dark:border-zinc-800"
      >
        In this prototype the test is answered locally — no request leaves the browser and nothing
        is billed.
      </p>
    </section>

    <!-- removal -->
    <section class="card border-red-200 p-3 dark:border-red-500/30">
      <h3 class="label mb-1">Remove this endpoint</h3>
      <UiTooltip text="Removal is undoable from the toast that appears." side="top">
        <p class="text-[11px] leading-relaxed text-zinc-500">
          <template v-if="busy"
            >{{ busy }} unfinished job{{ busy === 1 ? "" : "s" }} would have to be cancelled first —
            cancel them from the header, then remove.</template
          >
          <template v-else-if="u.kind === 'tts'"
            >Speakers whose voice lives here lose their routing and show as unrouted until they are
            repicked. Clips already rendered keep playing and keep their recorded cost; the request
            history on this page is sample data and goes with the endpoint.</template
          >
          <template v-else
            >Jobs already recorded keep the model and prices they ran with, so past spend does not
            change. If this endpoint is the one selected for runs, pick another before starting
            one.</template
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
