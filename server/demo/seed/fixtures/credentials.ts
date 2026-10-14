// The demo's credential registry: which provider account each endpoint uses, so several can share
// one. Names only; the demo holds no keys.
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
