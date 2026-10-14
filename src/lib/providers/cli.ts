// A scripting endpoint that runs Codex (`codex exec`) or Claude Code (`claude -p`) on this computer
// under the tool's own login. Picked by base URL: `codex:` and `claude-code:` name no host, so
// nothing goes over HTTP by mistake; an optional program path follows the colon.
import type { ReasoningEffort } from "@/types";

export type CliId = "codex" | "claude";

export interface CliShape {
  id: CliId;
  label: string;
  /** colon included; a program's path may follow */
  scheme: string;
  /** run from the server's PATH when the base URL names no program */
  program: string;
  /** as the Connection tab shows it */
  command: string;
  /** what to do when it is not signed in */
  login: string;
  /** with a note when that is not what was asked */
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

/** `path` is empty for the program on PATH. */
export function cliOf(baseUrl: string): (CliShape & { path: string }) | null {
  const url = baseUrl.trim();
  const cli = CLIS.find((c) => url.toLowerCase().startsWith(c.scheme));
  return cli ? { ...cli, path: url.slice(cli.scheme.length).trim() } : null;
}
