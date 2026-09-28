// What importing a script file into a book would do, worked out without writing anything.
// See docs/script-transfer.md#import.
import type { ScriptImportPlan } from "@/types";
import type { Db } from "~/db/client";
import { AppError } from "~/lib/errors";

/** An uploaded script file: a `<book>.script.zip`, or one chapter's `.json` on its own. */
export interface ScriptUpload {
  /** the file's name as the browser sent it, which history's "Imported from …" reads */
  name: string;
  bytes: Uint8Array;
}

/** Read, check and match `upload` against `bookId`'s chapters; the plan the import page shows. */
export async function planScriptImport(
  _db: Db,
  _bookId: string,
  _upload: ScriptUpload,
): Promise<ScriptImportPlan> {
  throw new AppError(500, "Script import is not built yet");
}
