// The editor's player: one line, heard through the effect being edited, or as the voice made it
// while "Hold to compare" is held. One audio element switches between the two files in place, so
// comparing is a flick that keeps the place in the line rather than a restart. The effect's file is
// made again a moment after the chain last changed, so a slider dragged asks for one render, not
// one per step of the drag.
import { onScopeDispose, ref, watch } from "vue";

import { soundOf } from "@/lib/effects";
import type { Effect } from "@/types";
import type { TryLine } from "./lines";
import type { Previews } from "./preview";

const SETTLE_MS = 250;

/** A file's length, read from its header without playing it. */
function durationOf(url: string): Promise<number> {
  return new Promise((resolve) => {
    const probe = new Audio();
    probe.preload = "metadata";
    probe.onloadedmetadata = () => resolve(Number.isFinite(probe.duration) ? probe.duration : 0);
    probe.onerror = () => resolve(0);
    probe.src = url;
  });
}

export function useAudition(
  line: () => TryLine | null,
  effects: () => Effect[],
  previews: Previews,
) {
  const el = new Audio();
  const playing = ref(false);
  /** the effect's file is being made */
  const busy = ref(false);
  const time = ref(0);
  /** held down: the original until let go */
  const holding = ref(false);
  const effectUrl = ref<string | null>(null);
  const effectDuration = ref(0);

  el.addEventListener("play", () => {
    playing.value = true;
    // timeupdate fires a few times a second; a playhead wants every frame
    const tick = () => {
      time.value = el.currentTime;
      if (!el.paused) requestAnimationFrame(tick);
    };
    tick();
  });
  el.addEventListener("pause", () => (playing.value = false));
  el.addEventListener("seeked", () => (time.value = el.currentTime));

  let src: string | null = null;
  /** Put on whichever file should be heard now, at the same place, playing if it was. */
  function swap(): void {
    const want = holding.value ? (line()?.url ?? null) : effectUrl.value;
    if (!want || want === src) return;
    const at = el.currentTime;
    const was = !el.paused;
    src = want;
    el.src = want;
    el.addEventListener("loadedmetadata", () => (el.currentTime = at), { once: true });
    if (was) void el.play().catch(() => {});
  }

  let asked = 0;
  async function render(): Promise<void> {
    const l = line();
    const n = ++asked;
    if (!l) {
      effectUrl.value = null;
      return;
    }
    busy.value = true;
    const url = await previews.urlFor(l.url, effects());
    // a later line or chain asked since: that answer wins
    if (n !== asked) return;
    busy.value = false;
    effectUrl.value = url;
    effectDuration.value = url ? await durationOf(url) : 0;
    swap();
  }

  watch(
    () => line()?.key,
    () => {
      const was = !el.paused;
      el.pause();
      src = null;
      time.value = 0;
      effectUrl.value = null;
      void render().then(() => {
        if (was) void play();
      });
    },
    { immediate: true },
  );
  let settle: ReturnType<typeof setTimeout> | undefined;
  watch(
    () => (line() ? soundOf(effects()) : null),
    () => {
      clearTimeout(settle);
      settle = setTimeout(() => void render(), SETTLE_MS);
    },
  );

  async function play(): Promise<void> {
    swap();
    if (src) await el.play().catch(() => {});
  }
  function toggle(): void {
    if (el.paused) void play();
    else el.pause();
  }
  function hold(on: boolean): void {
    if (holding.value === on) return;
    holding.value = on;
    swap();
  }
  function seek(seconds: number): void {
    el.currentTime = seconds;
    time.value = seconds;
  }
  function stop(): void {
    el.pause();
  }
  onScopeDispose(() => {
    clearTimeout(settle);
    el.pause();
    el.removeAttribute("src");
  });

  return { playing, busy, time, holding, effectUrl, effectDuration, toggle, hold, seek, stop };
}
