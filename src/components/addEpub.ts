// The Add EPUB dialog's draft: what was dropped, and whether it becomes a new novel or a volume.

/** A file the person chose, as the dialog carries it: its name, and the EPUB the server is sent. */
export interface PickedFile {
  name: string;
  source: File;
}

/** The file an `<input type="file">` or a drop is holding, or null when it is holding none. */
export function pickedFrom(files: FileList | null | undefined): PickedFile | null {
  const source = files?.[0];
  return source ? { name: source.name, source } : null;
}

export interface PendingAdd {
  /** the file's name, as the dialog and the volume row show it */
  file: string;
  /** the EPUB itself */
  source: File;
  mode: "new" | "volume";
  bookId: string;
  title: string;
  volName: string;
}

/** Start a dialog for a chosen file. */
export function pendingFor({ name, source }: PickedFile, bookId: string | null): PendingAdd {
  const guess = name.replace(/\.epub$/i, "");
  return {
    file: name,
    source,
    mode: bookId ? "volume" : "new",
    bookId: bookId ?? "",
    title: guess,
    volName: guess,
  };
}
