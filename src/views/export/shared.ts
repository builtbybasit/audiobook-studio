// Formatting shared by the Export panels, so they never disagree about "12h 04m" or "1.4 GB", and
// the audiobooks query as every page that says "needs an update" reads it.
import { toValue, watch, type MaybeRefOrGetter } from "vue";

import { clockDuration, minuteDuration } from "@/lib/time";
import { useBookExports } from "@/queries";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { useLibraryStore } from "@/stores/library";

/** A long span: hours and minutes, or minutes and seconds under an hour. */
export const hms = (s: number): string =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`
    : minuteDuration(s);

export const clock = clockDuration;

/** Megabytes, promoted to GB once the number stops being readable. */
export const mb = (n: number): string =>
  n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} GB` : `${Math.round(n)} MB`;

/** Where a finished export is on the server's disk: its file, or the folder a set is in. */
export const diskPath = (e: { files: { path?: string }[] }): string | null => {
  const path = e.files[0]?.path;
  if (!path || e.files.length === 1) return path ?? null;
  return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
};

/** Each book as its audiobooks' `changed` was last read against. */
const readAgainst = new Map<string, string>();

/**
 * A book's audiobooks, read again when the book changes in a way that can change a file. The
 * server decides `changed`, so a rename, a volume move, a pacing edit or a settled narration has
 * to be asked about; a chapter still narrating counts once it settles.
 */
export function useBookExportsKeptUp(bookId: MaybeRefOrGetter<string>) {
  const libraryStore = useLibraryStore();
  const query = useBookExports(bookId);
  const shape = (id: string): string => {
    const b = libraryStore.bookById(id);
    return JSON.stringify([
      b?.pacing,
      b?.readNotes,
      b?.volumes.map((v) => [v.id, v.name]),
      libraryStore
        .chaptersOf(id)
        .map((c) => [
          c.id,
          c.title,
          c.volumeId,
          c.excluded,
          c.narration,
          c.narration === "running" || c.narration === "queued" ? 0 : c.duration,
        ]),
    ]);
  };
  watch(
    () => `${toValue(bookId)}\n${shape(toValue(bookId))}`,
    (now) => {
      const id = now.slice(0, now.indexOf("\n"));
      const was = readAgainst.get(id);
      readAgainst.set(id, now);
      if (was != null && was !== now) void invalidate({ key: keys.exports(id) });
    },
    { immediate: true },
  );
  return query;
}
