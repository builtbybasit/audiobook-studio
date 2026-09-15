<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "reka-ui";
import {
  Plus as AddIcon,
  X as CloseIcon,
  Settings2 as SettingsIcon,
  Trash2 as RemoveIcon,
  ChevronDown as ExpandIcon,
} from "@lucide/vue";
import { UiSelect, UiCombobox, UiSwitch } from "@/ui";
import { useApp } from "@/stores/app";
import { expressionPositions, expressionSupport } from "@/lib/expressions";
import ExpressionsTab from "@/views/endpoints/ExpressionsTab.vue";
import ExpressionText from "@/components/ExpressionText.vue";
import type { Segment, ExpressionAnnotation } from "@/types";
const props = defineProps<{
  bookId: string;
  chapterId: number;
  segment: Segment;
  startOpen?: boolean;
}>();
const app = useApp();
const root = ref<HTMLElement | null>(null);
const expanded = ref(!!props.startOpen);
const settings = ref(false);
const selected = ref("");
const at = ref("0");
const route = computed(() => app.effectiveVoice(props.bookId, props.segment.speaker));
const endpoint = computed(() => route.value.endpoint);
const support = computed(() => expressionSupport(endpoint.value));
const tags = computed(() =>
  support.value === "supported" ? (endpoint.value?.expressions?.tags ?? []) : [],
);
const options = computed(() =>
  tags.value.map((t) => ({
    value: t.id,
    label: t.label,
    hint: t.token,
    group: t.kind === "sound" ? "Vocal sounds" : "Delivery instructions",
  })),
);
const positions = computed(() => expressionPositions(props.segment.text));
const plan = computed(() => app.expressionRender(props.bookId, props.segment));
const issue = (id: number) => plan.value.issues.find((i) => i.annotationId === id);
const change = (id: number, patch: Partial<ExpressionAnnotation> | null) =>
  app.updateExpression(props.bookId, props.chapterId, props.segment.id, id, patch);
async function insert() {
  const tag = tags.value.find((t) => t.id === selected.value);
  if (!tag) return;
  app.addExpression(props.bookId, props.chapterId, props.segment.id, tag, Number(at.value));
  selected.value = "";
  await nextTick();
  root.value?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus();
}
function replace(id: number, value: string) {
  const tag = tags.value.find((t) => t.id === value);
  if (tag) change(id, tag);
}
</script>

<template>
  <section ref="root" class="min-w-0 text-xs" data-expression-editor>
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="flex items-center gap-1 font-medium"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <ExpandIcon class="icon-sm transition-transform" :class="!expanded && '-rotate-90'" />
        Expressions <span class="text-zinc-400">{{ segment.expressions?.length || "" }}</span>
      </button>
      <span v-if="plan.issues.length" class="text-amber-600"
        >{{ plan.issues.length }} need review</span
      >
      <button class="btn-ghost btn-xs ml-auto" @click="expanded = true">
        <AddIcon class="icon-sm" /> Add expression
      </button>
    </div>
    <div v-if="expanded" class="mt-3 space-y-3">
      <div class="flex flex-wrap items-center gap-2 text-zinc-500">
        <span class="min-w-0 flex-1 break-words"
          >{{ segment.speaker }} → {{ endpoint?.name ?? "No voice assigned"
          }}<span v-if="endpoint"> · {{ endpoint.model }}</span></span
        ><button v-if="endpoint" class="btn-ghost btn-xs" @click="settings = true">
          <SettingsIcon class="icon-sm" /> Configure model tags
        </button>
      </div>
      <p
        v-if="support !== 'supported'"
        class="rounded-md bg-zinc-50 p-3 leading-relaxed text-zinc-500 dark:bg-zinc-800/50"
      >
        {{
          support === "unsupported"
            ? "This model is configured without expression tags. Assign another voice in Cast, configure this model, or omit the expressions below."
            : "Set up this model’s supported tags to enable the picker. Models may use different syntax, or support no tags."
        }}<span v-if="!endpoint"> Assign a voice to this speaker first.</span>
      </p>
      <form
        v-else
        class="space-y-2 rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50"
        @submit.prevent="insert"
      >
        <div class="grid gap-2 sm:grid-cols-2">
          <label
            >Expression<UiCombobox
              v-model="selected"
              :options="options"
              placeholder="Search supported expressions…"
              block
              class="mt-1"
              size="xs" /></label
          ><label
            >Position<UiSelect v-model="at" :options="positions" block class="mt-1" size="xs"
          /></label>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-zinc-500">Only this model’s configured tags are offered.</span
          ><button
            class="btn-primary btn-xs"
            type="submit"
            :disabled="!tags.some((t) => t.id === selected)"
          >
            <AddIcon class="icon-sm" /> Insert expression
          </button>
        </div>
      </form>
      <div
        v-for="a in segment.expressions"
        :key="a.annotationId"
        class="space-y-2 rounded-lg border p-3"
        :class="
          issue(a.annotationId)
            ? 'border-amber-300 dark:border-amber-600/50'
            : 'border-zinc-200 dark:border-zinc-700'
        "
      >
        <div class="flex flex-wrap items-center gap-2">
          <b>{{ a.label }}</b
          ><code class="text-violet-500">{{
            endpoint?.expressions?.tags.find((t) => t.id === a.id)?.token ?? a.token
          }}</code
          ><span class="text-zinc-400">{{ a.kind === "sound" ? "vocal sound" : "delivery" }}</span
          ><button
            class="btn-ghost btn-xs ml-auto"
            :aria-label="`Remove ${a.label} expression`"
            @click="change(a.annotationId, null)"
          >
            <RemoveIcon class="icon-sm" />
          </button>
        </div>
        <p v-if="issue(a.annotationId)" class="text-amber-700 dark:text-amber-300">
          {{ issue(a.annotationId)!.reason }}
        </p>
        <div class="grid gap-2 sm:grid-cols-2">
          <label
            >Position<UiSelect
              :model-value="String(a.at)"
              :options="
                positions.some((p) => p.value === String(a.at))
                  ? positions
                  : [
                      ...positions,
                      { value: String(a.at), label: 'Custom position — choose to move' },
                    ]
              "
              block
              class="mt-1"
              size="xs"
              @update:model-value="
                (v) => change(a.annotationId, { at: Number(v), needsReview: false })
              " /></label
          ><label v-if="tags.length"
            >Replace expression<UiCombobox
              :model-value="a.id"
              :options="options"
              block
              class="mt-1"
              size="xs"
              @update:model-value="(v) => replace(a.annotationId, String(v))"
          /></label>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UiSwitch
            :model-value="!!a.omitted"
            @update:model-value="(v) => change(a.annotationId, { omitted: !!v })"
            >Omit from narration</UiSwitch
          ><span v-if="a.omitted" class="text-zinc-500">Kept here; not sent to TTS.</span
          ><button
            v-if="a.needsReview"
            class="btn-ghost btn-xs"
            @click="change(a.annotationId, { needsReview: false })"
          >
            Keep this position
          </button>
        </div>
      </div>
      <div v-if="segment.expressions?.length" class="space-y-2">
        <div class="label">Placement in the line</div>
        <div
          class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-3 leading-relaxed dark:bg-zinc-800/50"
        >
          <ExpressionText :book-id="bookId" :segment="segment" />
        </div>
        <details>
          <summary class="w-fit cursor-pointer py-1 text-violet-500">
            {{
              plan.issues.length
                ? "Outgoing preview unavailable until issues are resolved"
                : "Preview exact text sent to TTS"
            }}
          </summary>
          <template v-if="!plan.issues.length"
            ><p class="mb-2 text-zinc-500">
              Includes pronunciation replacements and supported expressions. The book text stays
              unchanged.
            </p>
            <pre
              class="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 font-mono dark:bg-zinc-800/50"
              >{{ plan.text }}</pre>
          </template>
        </details>
      </div>
    </div>
    <DialogRoot v-model:open="settings"
      ><DialogPortal
        ><DialogOverlay class="fixed inset-0 z-50 bg-black/40" /><DialogContent
          class="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(680px,96vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-4 shadow-2xl focus:outline-none dark:bg-zinc-950"
          data-expression-editor
          ><div class="mb-2 flex items-center gap-2">
            <DialogTitle class="font-semibold">Model expressions</DialogTitle
            ><DialogClose class="btn-ghost btn-xs ml-auto" aria-label="Close model expressions"
              ><CloseIcon class="icon"
            /></DialogClose>
          </div>
          <DialogDescription class="mb-3 text-xs text-zinc-500"
            >Configure {{ endpoint?.name }} without leaving this line.</DialogDescription
          ><ExpressionsTab
            v-if="endpoint"
            :key="endpoint.id"
            :endpoint="endpoint" /></DialogContent></DialogPortal
    ></DialogRoot>
  </section>
</template>
