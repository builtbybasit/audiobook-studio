// Cast profiles: `facts` jobs read a scripted chapter again for its speakers' facts, and the
// book's `profiles` job rewrites every stale profile once its scripting and fact reading are done.
import type { Db } from "~/db/client";
import * as queue from "~/db/jobs";

/** Queued once per book: a second call while one waits returns it (the scripting endpoint stays the first's). */
export function enqueueProfiles(db: Db, bookId: string, profile: string): void {
  queue.enqueueJob(db, {
    kind: "profiles",
    bookId,
    chapterId: null,
    label: "Cast profiles",
    run: { profilesRun: { profile } },
  });
}
