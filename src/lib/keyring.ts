// API keys never enter the Pinia store (which a real app would persist / sync / log). They live in
// this in-memory, reactive map keyed by endpoint or profile id, and the store only asks `has()`.
import { reactive } from "vue";
const keys = reactive(new Map<string, string>());
export const keyring = {
  set(id: string, v: string): void {
    if (v) keys.set(id, v);
    else keys.delete(id);
  },
  has(id: string): boolean {
    return keys.has(id);
  },
  get(id: string): string {
    return keys.get(id) ?? "";
  },
  masked(id: string): string {
    const k = keys.get(id);
    return k ? k.slice(0, 3) + "••••" + k.slice(-4) : "";
  },
};
