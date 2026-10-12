// The scripting provider a server runs with: each run to the profile it was queued with.
//
// A profile whose base URL is `simulated://…` is answered here by the fake, which reads the prose
// and never the network, at the pace and failure rate the profile's simulation gives it. One whose
// base URL names a command-line tool (`codex:`, `claude-code:`) runs that tool on this computer.
// Every other profile goes to its chat-completions model. The choice is made per request, from the
// target, so one server holds real and simulated profiles side by side and nothing about which
// is which lives outside the Endpoints page.
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
