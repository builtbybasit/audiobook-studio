// The scripting provider a server runs with, chosen per request from the target: a simulated
// profile goes to the fake, a CLI base URL (`codex:`, `claude-code:`) to that tool, any other to
// its chat-completions model.
import { isSimulated } from "@/lib/providers";
import { cliOf } from "@/lib/providers/cli";
import { chatScriptingProvider, type ChatScriptingOptions } from "~/providers/chatScripting";
import { cliScriptingProvider, type CliScriptingOptions } from "~/providers/cliScripting";
import { fakeScriptingProvider, type FakeScriptingOptions } from "~/providers/fake";
import type { ScriptTarget, ScriptingProvider } from "~/providers/scripting";

export function endpointScriptingProvider(
  options: ChatScriptingOptions &
    Pick<CliScriptingOptions, "env"> &
    Pick<FakeScriptingOptions, "random"> = {},
): ScriptingProvider {
  const chat = chatScriptingProvider(options);
  const cli = cliScriptingProvider(options);
  const simulated = fakeScriptingProvider({ random: options.random });
  // a run with no profile goes to the chat provider, which refuses it and says why
  const via = (target: ScriptTarget | null): ScriptingProvider =>
    !target ? chat : isSimulated(target.baseUrl) ? simulated : cliOf(target.baseUrl) ? cli : chat;
  return {
    name: "Scripting profiles",
    callsProfile: true,
    script: (input) => via(input.target).script(input),
    probe: (target, signal, prompt) => via(target).probe!(target, signal, prompt),
  };
}
