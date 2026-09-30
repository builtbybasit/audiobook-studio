// The credential registry the demo's endpoints and profiles name: which provider account each
// one uses, so several can say they share one. A credential is only a name — the server keeps one
// key per endpoint and never sends it back, and the demo holds no key at all.
//
// A factory, like the endpoints beside it: every call builds a fresh list, so a scenario that
// renames one cannot leak into the next world.
import type { Credential } from "@/types";

export const makeCredentials = (): Credential[] => [
  { id: "openai-personal", label: "OpenAI · personal", note: "platform.openai.com, own billing" },
  { id: "deepseek", label: "DeepSeek", note: "" },
  { id: "proxy-work", label: "Azure proxy · work", note: "issued by the internal gateway" },
  {
    id: "fish-personal",
    label: "Fish Audio · personal",
    note: "fish.audio, billed per UTF-8 byte",
  },
];
