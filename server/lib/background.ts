// Fire-and-forget work (e.g. removing files). Bun exits on an unhandled rejection, so failures are
// logged as warnings instead.
import { log } from "~/log";

const disk = log.child({ name: "disk" });

export function inBackground(work: Promise<unknown> | undefined, what: string, fields = {}): void {
  void work?.catch((err: unknown) => disk.warn({ err, ...fields }, what));
}

/** Awaited, but a failure is only a warning (e.g. keeping a voice sample for next time). */
export async function warnIfFails(
  work: Promise<unknown>,
  what: string,
  fields = {},
): Promise<void> {
  await work.catch((err: unknown) => disk.warn({ err, ...fields }, what));
}
