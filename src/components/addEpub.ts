// The Add EPUB dialog's draft: what was dropped, and whether it becomes a new novel or a volume.
import type { Book } from "@/types";

/** A chosen file: its name, and the EPUB the server is sent. */
export interface PickedFile {
  name: string;
  source: File;
}

/** The file an `<input type="file">` or a drop holds, or null. */
export function pickedFrom(files: FileList | null | undefined): PickedFile | null {
  const source = files?.[0];
  return source ? { name: source.name, source } : null;
}

export interface PendingAdd {
  file: string;
  source: File;
  mode: "new" | "volume";
  bookId: string;
  /** blank: the EPUB's own title */
  title: string;
  volName: string;
}

export function pendingFor({ name, source }: PickedFile, bookId: string | null): PendingAdd {
  const guess = name.replace(/\.epub$/i, "");
  return {
    file: name,
    source,
    mode: bookId ? "volume" : "new",
    bookId: bookId ?? "",
    title: "",
    volName: guess,
  };
}

/** Books a file can go onto as the next volume: one already waiting in its review takes no other. */
export const volumeTargets = (shelved: readonly Book[]): Book[] =>
  shelved.filter((b) => !b.volumes.some((v) => v.importing));
