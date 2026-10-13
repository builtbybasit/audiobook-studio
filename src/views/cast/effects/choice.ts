// What an effects sheet chooses for, and the choosing: one speaker's effect on all their lines,
// one speaker's thought effect, or the book's thought effect. A line effect is chosen by the
// scripting model, not here: on its sheet (`line`) nothing is chosen, and a line is only heard
// through it.
//
// The list shows one row per effect plus None, and the row that is highlighted is what the subject
// hears now — a speaker whose thoughts follow the book is shown the book's row. So choosing a row
// is setting the subject's own choice, except that choosing the row the next level up already
// gives (the book's, for a speaker's thoughts; all books', for the book) is following it again:
// the subject goes back to null rather than holding a copy of the same choice that would stop
// following when the level above changes.
//
// Every change leaves `changed` — a line saying what now uses what, in the scope it was made in —
// with an undo that puts back exactly the choices it moved. A change to all books names how many
// other books follow it: their clips have the old sound now, and each is re-applied on its own page.
import { computed, ref } from "vue";

import { plural } from "@/lib/contents";
import { chainsFor } from "@/lib/effects";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import { useLibraryStore } from "@/stores/library";
import type { Effect, EffectSlot, ThoughtChoice } from "@/types";
import type { TryLine } from "./lines";

/** What the list chooses for: one of a speaker's two slots, or the book's thoughts; `line`, nothing. */
export type ChoiceView = EffectSlot | "book" | "line";

/** A row of the list: "none", or an effect's id. */
export type Row = string;

export interface Change {
  text: string;
  undo: () => void;
}

export function useChoice(bookId: () => string, view: () => ChoiceView, name: () => string) {
  const effectsStore = useEffectsStore();
  const libraryStore = useLibraryStore();
  const castStore = useCastStore();

  /** the row a stored choice shows as: an effect that is gone shows as None, as it plays */
  const rowOf = (c: ThoughtChoice | null | undefined): Row =>
    c && c !== "none" && effectsStore.byId.has(c) ? c : "none";
  const labelOf = (row: Row): string => effectsStore.byId.get(row)?.name ?? "None";

  const character = computed(() => {
    const v = view();
    if (v !== "effect" && v !== "thoughts") return undefined;
    return castStore.charactersOf(bookId()).find((c) => c.name === name());
  });
  const bookOwn = computed(() => libraryStore.bookById(bookId())?.thoughts ?? null);
  /** what every book that follows all books gets */
  const libraryRow = computed(() => rowOf(effectsStore.libraryThoughts));
  /** what this book's thought lines get */
  const bookRow = computed(() => rowOf(bookOwn.value ?? effectsStore.libraryThoughts));
  /** the subject's own choice; null where it follows the level above (or wears nothing) */
  const own = computed<string | null>(() => {
    const v = view();
    if (v === "line") return null;
    return v === "book" ? bookOwn.value : (character.value?.[v] ?? null);
  });
  /** whether the subject follows the level above: a speaker's thoughts the book, the book all books */
  const following = computed(
    () => (view() === "thoughts" || view() === "book") && own.value === null,
  );
  /** the row the subject hears now: the highlighted one */
  const current = computed<Row>(() => {
    if (view() === "effect") return rowOf(own.value);
    if (following.value) return view() === "book" ? libraryRow.value : bookRow.value;
    return rowOf(own.value);
  });
  /** the row of the level above, whose choice is following it again */
  const above = computed<Row>(() => (view() === "book" ? libraryRow.value : bookRow.value));

  const changed = ref<Change | null>(null);

  function setOwn(v: string | null): void {
    const who = name();
    if (view() === "line") return;
    if (view() === "effect") void castStore.setEffect(bookId(), who, v);
    else if (view() === "thoughts") void castStore.setThoughts(bookId(), who, v);
    else void libraryStore.setBookThoughts(bookId(), v);
  }

  /** The subject takes this row; the row above is following it again. */
  function choose(row: Row): void {
    if (view() === "line") return;
    const was = own.value;
    const next =
      view() === "effect" ? (row === "none" ? null : row) : row === above.value ? null : row;
    setOwn(next);
    const to = labelOf(row);
    changed.value = {
      text:
        view() === "effect"
          ? `${name()} now uses ${to}`
          : view() === "thoughts"
            ? `${name()}’s thoughts now use ${to}`
            : `This book now uses ${to}; other books are unchanged`,
      undo: () => setOwn(was),
    };
  }

  /** Whether the chosen row can be made the level above's: it is chosen, and isn't that already. */
  const canRaise = (row: Row): boolean =>
    (view() === "thoughts" || view() === "book") && row === current.value && row !== above.value;

  /**
   * The level above takes this row and the subject follows it again: on the book's sheet all books
   * take it; on a speaker's thoughts this book does.
   */
  function raise(row: Row): void {
    const id = bookId();
    const to = labelOf(row);
    const bookWas = bookOwn.value;
    if (view() === "book") {
      const libraryWas = effectsStore.libraryThoughts;
      void effectsStore.setLibraryThoughts(row);
      void libraryStore.setBookThoughts(id, null);
      const others = libraryStore.books.filter((b) => b.id !== id && b.thoughts == null).length;
      changed.value = {
        text: others
          ? `All books now use ${to} · ${plural(others, "other book follows", "other books follow")} it — Re-apply in each`
          : `All books now use ${to}`,
        undo: () => {
          void effectsStore.setLibraryThoughts(libraryWas);
          void libraryStore.setBookThoughts(id, bookWas);
        },
      };
    } else {
      const who = name();
      const was = own.value;
      void libraryStore.setBookThoughts(id, row === libraryRow.value ? null : row);
      void castStore.setThoughts(id, who, null);
      changed.value = {
        text: `This book now uses ${to}; other books are unchanged`,
        undo: () => {
          void libraryStore.setBookThoughts(id, bookWas);
          void castStore.setThoughts(id, who, was);
        },
      };
    }
  }

  function undo(): void {
    changed.value?.undo();
    changed.value = null;
  }

  /**
   * The effects a line plays through if the subject chose this row — `chainsFor` over what the
   * stores hold, with only the subject's choice swapped. On the book's sheet a speaker's own thought
   * effect is set aside too, so every thought line is heard through the row tried, after the
   * speaker's own effect. On a line effect's sheet the line carries that effect and only it.
   */
  function effectsFor(line: TryLine, row: Row): Effect[] {
    const ctx = effectsStore.contextFor(bookId());
    if (view() === "line") return chainsFor({ ...line, effects: [row] }, ctx);
    const cast = new Map(ctx.cast);
    const me = { ...cast.get(line.speaker) };
    if (view() === "effect") me.effect = row === "none" ? undefined : row;
    else if (view() === "thoughts") me.thoughts = row;
    else delete me.thoughts;
    cast.set(line.speaker, me);
    return chainsFor(line, { ...ctx, cast, book: view() === "book" ? row : ctx.book });
  }

  return {
    character,
    libraryRow,
    bookRow,
    own,
    following,
    current,
    above,
    changed,
    labelOf,
    choose,
    canRaise,
    raise,
    undo,
    effectsFor,
  };
}

export type Choice = ReturnType<typeof useChoice>;
