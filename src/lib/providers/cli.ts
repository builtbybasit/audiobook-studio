// A scripting endpoint that runs an AI command-line tool on this computer instead of calling an
// API: OpenAI's Codex (`codex exec`) or Claude Code (`claude -p`), signed in with the tool's own
// login — a ChatGPT or Claude subscription — so there is no base URL to call and no key to keep.
//
// It is picked the way the simulated one is, by its base URL: `codex:` and `claude-code:` name no
// host, so nothing is sent anywhere by HTTP by mistake. What follows the colon is the program to
// run when it is not the one on the server's PATH, `codex:/opt/homebrew/bin/codex`. Shared by the
// Endpoints page and the server (`server/providers/cliScripting.ts`), so what the page says is
// what is run.
import type { ReasoningEffort } from "@/types";

export type CliId = "codex" | "claude";

export interface CliShape {
  id: CliId;
  /** what the page and messages call it */
  label: string;
  /** the base URL that picks it, colon included; a program's path may follow */
  scheme: string;
  /** what is run when the base URL names no program: found on the server's PATH */
  program: string;
  /** the command line a request runs, as the Connection tab shows it */
  command: string;
  /** what to do when it is not signed in */
  login: string;
  /** a reasoning level as its flag spells it, and a sentence when that is not what was asked */
  effort(level: ReasoningEffort): { value: string; note: string | null };
}

export const CODEX: CliShape = {
  id: "codex",
  label: "Codex CLI",
  scheme: "codex:",
  program: "codex",
  command: "codex exec",
  login: "Run `codex login` in a terminal on this computer, then test again.",
  // `model_reasoning_effort`: none, minimal, low, medium, high, xhigh
  effort: (level) => ({
    value: level === "off" ? "none" : level,
    note: level === "off" ? "Sent as none; GPT-6 Astra can't turn reasoning off." : null,
  }),
};

export const CLAUDE_CODE: CliShape = {
  id: "claude",
  label: "Claude Code CLI",
  scheme: "claude-code:",
  program: "claude",
  command: "claude -p",
  login: "Run `claude` in a terminal on this computer and sign in with /login, then test again.",
  // `--effort`: low, medium, high, xhigh, max; there is no off
  effort: (level) =>
    level === "off"
      ? { value: "low", note: "Claude Code can't turn thinking off; it is sent as low." }
      : { value: level, note: null },
};

const CLIS: readonly CliShape[] = [CODEX, CLAUDE_CODE];

/**
 * The tool a base URL runs, and the program it names after the colon (empty: the one on PATH);
 * null for a base URL that is not one.
 */
export function cliOf(baseUrl: string): (CliShape & { path: string }) | null {
  const url = baseUrl.trim();
  const cli = CLIS.find((c) => url.toLowerCase().startsWith(c.scheme));
  return cli ? { ...cli, path: url.slice(cli.scheme.length).trim() } : null;
}
