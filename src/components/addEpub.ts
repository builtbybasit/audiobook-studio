// The Add EPUB dialog's draft: what was dropped, and whether it becomes a new novel or a volume.
import { sampleForFile } from "@/mock";

export interface PendingAdd {
  file: string;
  mode: "new" | "volume";
  bookId: string;
  title: string;
  volName: string;
  /** what the file turns out to contain — the prototype parses nothing */
  sample: string;
}

/** Start a dialog for a dropped file, or for a sample picked by name. */
export function pendingFor(file: string, bookId: string | null, sample?: string): PendingAdd {
  const guess = file.replace(/\.epub$/i, "");
  return {
    file,
    mode: bookId ? "volume" : "new",
    bookId: bookId ?? "",
    title: guess,
    volName: guess,
    sample: sample ?? sampleForFile(file),
  };
}
