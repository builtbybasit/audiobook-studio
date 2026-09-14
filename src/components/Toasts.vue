<script setup lang="ts">
// Toast stack on Toastflow's runtime (queue, timers, pause on hover, swipe, Escape, focus handling,
// live regions) with our own card through the headless slot. Nothing from the library's CSS is
// loaded; layout and motion live in src/toasts.css.
//
// UX rules baked in here:
//  · an undoable toast is marked ↻, keeps its Undo button first, shows the ⌘Z hint on the newest one,
//    and lives longer (10 s) with a visible time-left bar — hovering pauses it, so the user can read
//  · warnings and errors use role="alert" (from the library) and a stronger left accent, never a
//    full-colour background, so a run of toasts stays readable
//  · the close button only shows on hover / focus on pointer devices, always on touch
//  · buttons are real buttons with focus rings; Escape inside a toast dismisses it
import { computed } from "vue";
import { ToastContainer } from "vue-toastflow";
import type { Component } from "vue";
import {
  Check as CheckIcon,
  Info as InfoIcon,
  Dot as DotIcon,
  TriangleAlert as WarnIcon,
  X as CloseIcon,
  Undo2 as UndoIcon,
} from "@lucide/vue";
import { useApp } from "@/stores/app";
const app = useApp();
const isMac = /Mac|iPhone/.test(navigator.platform);
const newestUndoId = computed(() => app._undo.at(-1)?.toastId);

const ACCENT = {
  success: "border-l-emerald-500",
  info: "border-l-violet-500",
  default: "border-l-zinc-400",
  warning: "border-l-amber-500",
  error: "border-l-red-500",
  loading: "border-l-violet-400",
  custom: "border-l-zinc-400",
};
const BAR = {
  success: "bg-emerald-500",
  info: "bg-violet-500",
  default: "bg-zinc-400",
  warning: "bg-amber-500",
  error: "bg-red-500",
  loading: "bg-violet-400",
  custom: "bg-zinc-400",
};
const ICON: Record<string, Component> = {
  success: CheckIcon,
  info: InfoIcon,
  default: DotIcon,
  warning: WarnIcon,
  error: CloseIcon,
  custom: DotIcon,
};
const ICON_CLS = {
  success: "text-emerald-500",
  info: "text-violet-500",
  default: "text-zinc-400",
  warning: "text-amber-500",
  error: "text-red-500",
  loading: "text-violet-500",
  custom: "text-zinc-400",
};
const isUndo = (t: { theme?: string }) => t.theme === "undo";
const btnCls = (b: { id?: string }) =>
  b.id === "undo"
    ? "border-violet-500 bg-violet-600 text-white hover:bg-violet-500 focus-visible:ring-violet-400"
    : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 focus-visible:ring-violet-400 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700";
</script>

<template>
  <ToastContainer v-slot="{ toast, ui }">
    <div v-bind="ui.wrapperProps">
      <article
        v-bind="
          ui.getRootProps({
            class: [
              'group relative overflow-hidden rounded-xl border border-l-[3px] border-zinc-200 bg-white/95 text-sm shadow-lg shadow-black/10 backdrop-blur outline-none ring-violet-400 focus-within:ring-2 dark:border-zinc-700 dark:bg-zinc-900/95 dark:shadow-black/40',
              ACCENT[toast.type] ?? ACCENT.default,
            ],
          })
        "
      >
        <div class="flex items-start gap-3 py-3 pl-3.5 pr-9">
          <!-- icon -->
          <span
            class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center text-[13px] font-bold leading-none"
            :class="ICON_CLS[toast.type]"
            aria-hidden="true"
          >
            <svg
              v-if="toast.type === 'loading'"
              class="toast-spin h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                stroke-opacity=".25"
                stroke-width="3"
              />
              <path
                d="M21 12a9 9 0 0 0-9-9"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
              />
            </svg>
            <component
              v-else
              :is="isUndo(toast) ? UndoIcon : (ICON[toast.type] ?? DotIcon)"
              class="icon"
            />
          </span>
          <!-- text -->
          <div class="min-w-0 flex-1">
            <p
              class="font-medium leading-snug text-zinc-900 dark:text-zinc-100"
              :aria-label="ui.a11y.titleLabel"
            >
              {{ toast.title }}
            </p>
            <p
              v-if="toast.description"
              class="mt-0.5 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400"
            >
              {{ toast.description }}
            </p>
            <!-- buttons -->
            <div
              v-if="ui.buttons.has"
              v-bind="
                ui.buttons.getGroupProps({ class: 'mt-2 flex flex-wrap items-center gap-1.5' })
              "
            >
              <template v-for="b in ui.buttons.items" :key="b.id ?? b.label">
                <button
                  v-bind="
                    ui.getButtonProps(b, {
                      class: [
                        'rounded-md border px-2.5 py-1 text-xs font-semibold leading-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-zinc-900',
                        btnCls(b),
                      ],
                    })
                  "
                >
                  {{ b.label }}
                </button>
                <kbd
                  v-if="b.id === 'undo' && newestUndoId === toast.id"
                  class="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-400 dark:border-zinc-700"
                  title="undo from anywhere"
                  >{{ isMac ? "⌘" : "Ctrl" }} Z</kbd
                >
              </template>
            </div>
          </div>
        </div>
        <!-- close: hover/focus on pointer devices, always on touch -->
        <button
          v-bind="
            ui.getCloseProps({
              class:
                'absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-900 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
            })
          "
        >
          <CloseIcon class="icon" />
        </button>
        <!-- time left -->
        <div v-if="ui.progress.show" v-bind="ui.progress.getWrapperProps()" aria-hidden="true">
          <div v-bind="ui.progress.getTrackProps({ class: 'bg-zinc-100 dark:bg-zinc-800' })">
            <div
              v-bind="
                ui.progress.getBarProps({ class: ['opacity-70', BAR[toast.type] ?? BAR.default] })
              "
            />
          </div>
        </div>
      </article>
    </div>
  </ToastContainer>
</template>
