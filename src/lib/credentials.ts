// Named credentials: which provider account an endpoint uses, so several endpoints can say they
// share one. A credential is only a name — the server keeps one key per endpoint and never sends it
// back, so no key is ever here.
//
// The registry travels with the endpoint configuration (`EndpointConfig.credentials`), and the
// endpoints store refills this list in place from what the server holds. What it starts as is the
// demo library's registry, which the server seeds the demo with.
import { reactive } from "vue";

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

export function addCredential(label: string): string {
  const id = "cred-" + Math.random().toString(36).slice(2, 8);
  credentials.push({ id, label: label.trim() || "New credential", note: "" });
  return id;
}
