// One toast per burst of repeated keypresses on a line, sent once it settles; its undo returns to
// where the burst began.
import { onUnmounted } from "vue";

const BURST_MS = 700;

export function useBurstToast() {
  let burst: { key: string; timer: ReturnType<typeof setTimeout>; send: () => void } | null = null;
  /** Mid-burst on this key: the caller keeps the starting value. */
  const continuing = (key: string) => burst?.key === key;
  function announce(key: string, send: () => void) {
    if (burst) {
      clearTimeout(burst.timer);
      if (burst.key !== key) burst.send(); // flush the other line's message first
    }
    burst = { key, send, timer: setTimeout(flush, BURST_MS) };
  }
  function flush() {
    const pending = burst;
    burst = null;
    pending?.send();
  }
  onUnmounted(flush);
  return { continuing, announce };
}
