// One message per burst of keypresses.
//
// The keys that repeat — [ ] on the pause, 1–9 on the speaker — change a line you may not be
// looking at, so they have to say what they did. One toast per press would bury the page under
// near-identical messages, so a run of presses on the same line is announced once it settles, and
// its undo steps back to where the run began rather than one press into it.
import { onUnmounted } from "vue";

const BURST_MS = 700;

export function useBurstToast() {
  let burst: { key: string; timer: ReturnType<typeof setTimeout>; send: () => void } | null = null;
  /** Still mid-run on this key — the caller keeps the value the run started from. */
  const continuing = (key: string) => burst?.key === key;
  function announce(key: string, send: () => void) {
    if (burst) {
      clearTimeout(burst.timer);
      if (burst.key !== key) burst.send(); // a different line: let its message out before this one
    }
    burst = { key, send, timer: setTimeout(flush, BURST_MS) };
  }
  function flush() {
    const pending = burst;
    burst = null;
    pending?.send();
  }
  onUnmounted(flush); // leaving the chapter mid-run still owes you the message
  return { continuing, announce };
}
