// The scripting endpoints (LLM side) the prototype starts with. `newProfile` fills in every
// operational default, so these entries only say what actually differs between the three.
import { newProfile } from "@/lib/scripting";
import type { Profile, ScriptSettings } from "@/types";

export function makeProfiles(): Profile[] {
  return [
    newProfile({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      inPrice: 0.15,
      outPrice: 0.6,
      secPerChunk: 9,
      credentialId: "openai-personal",
      quotaGroup: "openai-account",
      spendLimit: 10,
    }),
    newProfile({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      inPrice: 0.14,
      outPrice: 0.28,
      secPerChunk: 14,
      credentialId: "deepseek",
    }),
    newProfile({
      id: "antigravity",
      name: "Antigravity (local)",
      baseUrl: "http://localhost:8000/v1",
      model: "gemini-3.6-flash-low",
      needsKey: false,
      secPerChunk: 25,
    }),
  ];
}

export const makeScriptSettings = (): ScriptSettings => ({
  profile: "openai",
  stripWatermarks: true,
});
