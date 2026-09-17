// Named credentials, so several endpoints can point at one key instead of each holding its own
// copy. The secrets themselves never enter the Pinia store: they live in the same in-memory
// `keyring` as before, under `cred:<id>`.
//
// Binding a credential to an endpoint *mirrors* the secret into that endpoint's own keyring slot
// (`<endpointId>` for TTS, `profile:<id>` for scripting), which is what the dispatcher already
// checks. So selecting a credential changes where the key is managed, not how a request finds it.
import { reactive } from "vue";
import { keyring } from "@/lib/keyring";

export interface Credential {
  id: string;
  label: string;
  /** free-text reminder of which account this is — never the key itself */
  note: string;
}

export const credentials = reactive<Credential[]>([
  { id: "openai-personal", label: "OpenAI · personal", note: "platform.openai.com, own billing" },
  { id: "deepseek", label: "DeepSeek", note: "" },
  { id: "proxy-work", label: "Azure proxy · work", note: "issued by the internal gateway" },
  {
    id: "fish-personal",
    label: "Fish Audio · personal",
    note: "fish.audio, billed per UTF-8 byte",
  },
]);

const slotKey = (id: string): string => "cred:" + id;
/** keyring slot → credential id, for re-mirroring when a secret changes */
const bound = reactive(new Map<string, string>());

export const credentialById = (id: string | null | undefined): Credential | undefined =>
  id ? credentials.find((c) => c.id === id) : undefined;

export const credentialSecret = (id: string): string => keyring.get(slotKey(id));
export const credentialHasSecret = (id: string): boolean => keyring.has(slotKey(id));

/** Point one endpoint's key slot at a credential (or back at its own hand-typed key). */
export function bindCredential(slot: string, credentialId: string | null): void {
  if (!credentialId) {
    bound.delete(slot);
    return;
  }
  bound.set(slot, credentialId);
  keyring.set(slot, credentialSecret(credentialId));
}

export function setCredentialSecret(id: string, value: string): void {
  keyring.set(slotKey(id), value);
  for (const [slot, cid] of bound) if (cid === id) keyring.set(slot, value);
}

export function addCredential(label: string): string {
  const id = "cred-" + Math.random().toString(36).slice(2, 8);
  credentials.push({ id, label: label.trim() || "New credential", note: "" });
  return id;
}

/** Endpoints keep their `credentialId`, so removing one leaves them pointing at nothing — the
 *  caller is expected to warn about that before calling this. */
export function removeCredential(id: string): void {
  const i = credentials.findIndex((c) => c.id === id);
  if (i >= 0) credentials.splice(i, 1);
  keyring.set(slotKey(id), "");
  const stale: string[] = [];
  for (const [slot, cid] of bound) if (cid === id) stale.push(slot);
  for (const slot of stale) bound.delete(slot);
}
