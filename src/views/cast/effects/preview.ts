// A line run through effects, as a URL an audio element can play — made once per line and sound.
//
// The server renders each preview (`effectsStore.preview`), which takes a moment, and the sheet
// asks for the same one over and over: ▶ on a row twice, back and forth between lines, a slider
// returned to where it was. So renders are kept, keyed by the clip and by what the effects do to
// it (`soundOf`, which leaves out names, ids and off steps), and the oldest go once there are
// more than `KEEP`. Effects that do nothing play the clip itself, with no request at all. Every
// object URL made is revoked when the scope that asked for them ends.
import { onScopeDispose } from "vue";

import { runnable, soundOf } from "@/lib/effects";
import { useEffectsStore } from "@/stores/effects";
import type { Effect } from "@/types";

const KEEP = 40;

export function usePreviews() {
  const effectsStore = useEffectsStore();
  const made = new Map<string, Promise<string | null>>();

  const revoke = (p: Promise<string | null>) =>
    void p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});

  /** The clip at `url` through `effects`, in order; null when the server refused (it toasts). */
  function urlFor(url: string, effects: Effect[]): Promise<string | null> {
    const sound = soundOf(effects);
    if (!sound) return Promise.resolve(url);
    const key = `${sound} ${url}`;
    const hit = made.get(key);
    if (hit) {
      // used again: it goes to the back of the line to be dropped
      made.delete(key);
      made.set(key, hit);
      return hit;
    }
    const chains = effects.map((e) => runnable(e.chain)).filter((c) => c.length);
    const out = effectsStore.preview(url, chains).then((b) => b && URL.createObjectURL(b));
    // a refusal is not kept: asking again asks the server again
    void out.then((u) => {
      if (!u && made.get(key) === out) made.delete(key);
    });
    made.set(key, out);
    for (const [k, p] of made) {
      if (made.size <= KEEP) break;
      made.delete(k);
      revoke(p);
    }
    return out;
  }

  function clear(): void {
    for (const p of made.values()) revoke(p);
    made.clear();
  }
  onScopeDispose(clear);

  return { urlFor, clear };
}

export type Previews = ReturnType<typeof usePreviews>;
