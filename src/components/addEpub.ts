// The Add EPUB dialog's draft: what was dropped, and whether it becomes a new novel or a volume.
import { sampleForFile } from "@/mock";

/**
 * A file the person chose, as the dialog carries it.
 *
 * `source` is the EPUB itself and is what a server is sent; it is absent only when nothing real
 * was picked — the sample menu, which names a seeded book rather than opening a file.
 */
export interface PickedFile {
  name: string;
  source?: File;
}

/** The file an `<input type="file">` or a drop is holding, or null when it is holding none. */
export function pickedFrom(files: FileList | null | undefined): PickedFile | null {
  const source = files?.[0];
  return source ? { name: source.name, source } : null;
}

export interface PendingAdd {
  /** the file's name, as the dialog and the volume row show it */
  file: string;
  /** the EPUB itself, when there is one to send */
  source?: File;
  mode: "new" | "volume";
  bookId: string;
  title: string;
  volName: string;
  /** what the file turns out to contain — the seeded world parses nothing */
  sample: string;
}

/** Start a dialog for a chosen file, or for a sample picked by name. */
export function pendingFor(
  picked: PickedFile | string,
  bookId: string | null,
  sample?: string,
): PendingAdd {
  const { name, source } =
    typeof picked === "string" ? { name: picked, source: undefined } : picked;
  const guess = name.replace(/\.epub$/i, "");
  return {
    file: name,
    source,
    mode: bookId ? "volume" : "new",
    bookId: bookId ?? "",
    title: guess,
    volName: guess,
    sample: sample ?? sampleForFile(name),
  };
}
