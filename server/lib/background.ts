// Work nobody waits for, that must not take the server down when it fails.
//
// Removing a book's files, or an audiobook's, is started and left: the rows are already gone, the
// response should not wait on a slow disk, and nothing that follows depends on the files being
// gone. But a promise nobody holds a handle to that rejects is an unhandled rejection, and Bun
// exits on one — so an `rm` that met a permission error, or a directory a narration job was still
// writing into, used to end the whole process over a leftover directory. A leftover directory is
// a warning in the log.
import { log } from "~/log";

const disk = log.child({ name: "disk" });

/** Let `work` finish on its own, and log it if it fails rather than letting it reject unheard. */
export function inBackground(work: Promise<unknown> | undefined, what: string, fields = {}): void {
  void work?.catch((err: unknown) => disk.warn({ err, ...fields }, what));
}
