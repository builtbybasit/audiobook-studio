// How a reasoning level is spelled on the wire, host by host, with the nearest level a host takes
// and a note for the Endpoints page when it differs. Shared by page and server, so what the page
// says is what is sent. Each rule names the docs it follows.
import type { ReasoningEffort } from "@/types";
import { gemini } from "@/lib/providers/gemini";
import { openai } from "@/lib/providers/openai";
import { cliOf } from "@/lib/providers/cli";
import { isSimulated } from "@/lib/providers/simulated";

export interface ReasoningRequest {
  /** spread into the request body */
  fields: Record<string, unknown>;
  /** for the page when the host cannot do exactly what was asked */
  note: string | null;
  /** the host rejects or ignores `temperature` at this level, so it is left out */
  omitTemperature: boolean;
}

const nothing = (): ReasoningRequest => ({ fields: {}, note: null, omitTemperature: false });

interface Host {
  matches(baseUrl: string): boolean;
  request(effort: ReasoningEffort): ReasoningRequest;
}

const hostIs =
  (name: string) =>
  (baseUrl: string): boolean =>
    new RegExp(`(^|//)${name.replace(/\./g, "\\.")}(/|:|$)`, "i").test(baseUrl.trim());

/** The local servers are known by their default port. */
const portIs =
  (port: number) =>
  (baseUrl: string): boolean =>
    new RegExp(`^[a-z]+://[^/]*:${port}(/|$)`, "i").test(baseUrl.trim());

const effortField = (value: string): Record<string, unknown> => ({ reasoning_effort: value });

const HOSTS: readonly Host[] = [
  {
    // https://developers.openai.com/api/docs/guides/reasoning and …/guides/latest-model: `none`
    // through `max`; GPT-6 Astra answers `none` with a 400. "When reasoning effort is not `none`,
    // remove `temperature`, `top_p`, and `top_logprobs`."
    matches: openai.matches,
    request: (effort) => ({
      fields: effortField(effort === "off" ? "none" : effort),
      note:
        effort === "off"
          ? "GPT-6 Astra can't turn reasoning off and refuses the request; Luna and Sol can."
          : null,
      omitTemperature: effort !== "off",
    }),
  },
  {
    // https://openrouter.ai/docs/use-cases/reasoning-tokens: a `reasoning` object; `effort: "none"`
    // turns it off, and a model whose reasoning is mandatory rejects that. OpenRouter maps a level a
    // model lacks to its nearest, and drops a parameter a model does not take.
    matches: hostIs("openrouter.ai"),
    request: (effort) => ({
      fields: { reasoning: { effort: effort === "off" ? "none" : effort } },
      note:
        effort === "off"
          ? "A model that always reasons, such as Grok 4.7 or Claude Opus 5.5, refuses off through OpenRouter."
          : null,
      omitTemperature: false,
    }),
  },
  {
    // https://api-docs.deepseek.com/guides/thinking_mode and …/api/create-chat-completion:
    // `thinking.type` switches thinking; `reasoning_effort` is `low`, `high` or `max`, and `medium` is
    // taken as `high`. In thinking mode `temperature` has no effect, without an error.
    matches: hostIs("api.deepseek.com"),
    request: (effort) =>
      effort === "off"
        ? { fields: { thinking: { type: "disabled" } }, note: null, omitTemperature: false }
        : {
            fields: effortField(effort === "medium" ? "high" : effort),
            note: effort === "medium" ? "DeepSeek has no medium level; it is sent as high." : null,
            omitTemperature: true,
          },
  },
  {
    // https://ai.google.dev/gemini-api/docs/openai: `reasoning_effort`; "Reasoning cannot be turned
    // off for Gemini 2.5 Pro or 3 models". Gemini 3.8 Flash takes low, medium and high.
    matches: gemini.matches,
    request: (effort) => ({
      fields: effortField(effort === "off" ? "low" : effort),
      note:
        effort === "off" ? "Gemini 3 models can't turn reasoning off; it is sent as low." : null,
      omitTemperature: false,
    }),
  },
  {
    // https://platform.claude.com/docs/en/api/openai-sdk: `reasoning_effort` is ignored; thinking is
    // set with `thinking`, whose `disabled` Claude Opus 5.5 answers with a 400
    // (…/build-with-claude/thinking). Claude 5 models answer any non-default `temperature` with a 400,
    // and older ones may not have it while thinking.
    matches: hostIs("api.anthropic.com"),
    request: (effort) =>
      effort === "off"
        ? {
            fields: { thinking: { type: "disabled" } },
            note: "Claude Opus 5.5 can't turn thinking off and refuses the request; Sonnet 5 and Haiku 4.5 can.",
            omitTemperature: true,
          }
        : {
            fields: {},
            note: "Anthropic's OpenAI compatibility layer ignores a reasoning level, so nothing is sent and Claude decides how hard to think.",
            omitTemperature: true,
          },
  },
  {
    // https://docs.x.ai/docs/guides/reasoning and …/models: Grok 4.7 takes low to xhigh and
    // "Reasoning cannot be disabled"; Grok 4.3 also takes `none`. Low is what both accept.
    matches: hostIs("api.x.ai"),
    request: (effort) => ({
      fields: effortField(effort === "off" ? "low" : effort),
      note:
        effort === "off"
          ? "Not every Grok model can turn reasoning off (Grok 4.7 can't), so it is sent as low."
          : null,
      omitTemperature: false,
    }),
  },
  {
    // https://docs.ollama.com/api/openai-compatibility: `reasoning_effort`, with values per model
    // (`/api/show`); a model that only switches thinking on or off takes `none` as off.
    matches: portIs(11434),
    request: (effort) => ({
      fields: effortField(effort === "off" ? "none" : effort),
      note: "Which levels Ollama takes depends on the model; its /api/show lists them.",
      omitTemperature: false,
    }),
  },
  {
    // https://lmstudio.ai/changelog/lmstudio-v0.4.8: `reasoning_effort` on /v1/chat/completions from
    // 0.4.8, with no value documented as off.
    matches: portIs(1234),
    request: (effort) =>
      effort === "off"
        ? {
            fields: effortField("low"),
            note: "LM Studio documents no way to turn reasoning off; it is sent as low.",
            omitTemperature: false,
          }
        : {
            fields: effortField(effort),
            note: "LM Studio takes a reasoning level from version 0.4.8, for models that reason.",
            omitTemperature: false,
          },
  },
];

/** Hosts whose models refuse `temperature` even when no level is asked for. */
const REFUSE_TEMPERATURE: readonly ((baseUrl: string) => boolean)[] = [
  openai.matches,
  hostIs("api.anthropic.com"),
];

export function reasoningRequest(
  baseUrl: string,
  effort: ReasoningEffort | null | undefined,
): ReasoningRequest {
  if (isSimulated(baseUrl)) return nothing();
  // a command-line tool takes the level as a flag of its own (`@/lib/providers/cli`), not a field
  const cli = cliOf(baseUrl);
  if (cli) return { ...nothing(), note: effort ? cli.effort(effort).note : null };
  // GPT-6 reasons by default and Claude 5 refuses a non-default temperature, level or not
  if (!effort) return { ...nothing(), omitTemperature: REFUSE_TEMPERATURE.some((m) => m(baseUrl)) };
  const host = HOSTS.find((h) => h.matches(baseUrl));
  if (host) return host.request(effort);
  return {
    fields: effortField(effort === "off" ? "none" : effort),
    note: "This host isn't one the app knows, so the level is sent as OpenAI spells it, reasoning_effort.",
    omitTemperature: false,
  };
}
