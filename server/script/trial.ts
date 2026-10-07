// Trying a prompt on one chunk: the prompt being edited, sent with one real chunk of a chapter, to
// see what the model makes of it before anything is saved.
//
// It is built the way a run builds a request (`~/jobs/scripting`): the chapter cut as the endpoint
// cuts it (`scriptParts`), the layers resolved (`resolvePrompt`) — each one the draft when the
// page sent one, else what is saved — and the tags filled from the book, the chapter, its cast and
// the chunk's place in it. What differs is what happens to the answer. Nothing is written: not the
// script, not its history, not the cast, not the recap — those two come back beside the lines. The lines come back to the page with the word-for-word
// check a run would hold them to, and an answer a run would refuse — a model that dropped a
// sentence, a refusal, something that is not a script — is shown as what came back, not raised.
//
// The request is real, though, and so is its bill. It is held to the book's budget at its worst
// case before it goes, like a run's first request, and what it used is priced into the book's
// ledger against the chapter, where it counts toward spend like any other.
import type {
  BookPrompt,
  ProfilePrompt,
  PromptTemplate,
  PromptTrialRequest,
  PromptTrialResult,
} from "@/types";
import {
  notesProblems,
  promptProblems,
  renderPrompt,
  resolvePrompt,
  type PromptVars,
} from "@/lib/prompt";
import { expressionNames } from "@/lib/expressions";
import { tokenEstimate } from "@/lib/scripting";
import { readSpeakers } from "~/db/cast";
import type { Db } from "~/db/client";
import { readEndpoints, readProfiles } from "~/db/endpoints";
import * as library from "~/db/library";
import { readLibraryPrompt } from "~/db/settings";
import { plainText } from "~/epub/markdown";
import { badRequest, conflict, notFound } from "~/lib/errors";
import { fidelity } from "~/providers/chatScripting";
import { ProviderError } from "~/providers/http";
import type { ScriptAnswer, ScriptingProvider } from "~/providers/scripting";
import type { SentScript } from "~/providers/sent";
import { scriptTarget } from "~/providers/target";
import { beforeOf, chunksOf } from "~/script/chunks";
import { assertWithinBudget } from "~/usage/budget";
import { settleScript } from "~/usage/ledger";

/** A draft when the page sent one — `null` included, which is a choice — else what is saved. */
const draftOr = <T>(draft: T | null | undefined, saved: T | null | undefined): T | null =>
  draft !== undefined ? draft : (saved ?? null);

/**
 * Send one chunk of a chapter with the prompt the drafts resolve to, and say what came back.
 *
 * Refuses (404) an unknown book, endpoint or chapter; (400) a part the chapter is not cut into, or
 * a prompt that could not be saved as it stands; (409) a book still in its contents review, or one
 * whose budget cannot take the chunk's worst case. A paused endpoint may still be tried. Aborting
 * `signal` stops the request, and nothing is priced for a request dropped halfway.
 */
export async function tryPrompt(
  db: Db,
  provider: ScriptingProvider,
  bookId: string,
  request: PromptTrialRequest,
  signal: AbortSignal,
): Promise<PromptTrialResult> {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  if (book.importing) throw conflict("Finish the contents review before scripting this book");
  const profile = readProfiles(db).find((p) => p.id === request.profile);
  if (!profile) throw notFound(`There is no scripting endpoint “${request.profile}”`);
  const chapter = library.getChapter(db, bookId, request.chapterId);
  const uid = library.chapterUid(db, bookId, request.chapterId);
  const body = chapter && library.getChapterBody(db, bookId, request.chapterId);
  if (!chapter || uid == null || body == null) throw notFound(`${book.title} has no such chapter`);

  // Cut as the endpoint cuts it, so part 3 here is part 3 of a run.
  const chunks = chunksOf(plainText(body), profile);
  const part = request.part ?? 1;
  if (part < 1 || part > chunks.length)
    throw badRequest(
      `${profile.name} cuts ${library.chapterName(db, bookId, request.chapterId)} into ${chunks.length} part${chunks.length === 1 ? "" : "s"}; there is no part ${part}`,
    );
  const excerpt = chunks[part - 1];

  const layers = {
    library: draftOr<PromptTemplate>(request.library, readLibraryPrompt(db)),
    profile: draftOr<ProfilePrompt>(request.profilePrompt, profile.prompt),
    book: draftOr<BookPrompt>(request.book, book.prompt),
  };
  const template = resolvePrompt(layers);
  const problems = [
    ...promptProblems(template),
    ...notesProblems(layers.book?.notes ?? ""),
    ...notesProblems(layers.profile?.notes ?? ""),
  ];
  if (problems.length) throw badRequest(`This prompt cannot be sent: ${problems.join(" ")}`);

  // The speakers the book has now, as a run's request would be told them.
  const speakers = readSpeakers(db, bookId);
  const vars: PromptVars = {
    book: { title: book.title, author: book.author ?? "", notes: layers.book?.notes ?? "" },
    chapter: {
      title: chapter.title,
      // as a run tells it (`scriptingHandler`): the reading number, the id for a skipped chapter
      number: library.readingNumber(db, bookId, request.chapterId) ?? request.chapterId,
    },
    part,
    parts: chunks.length,
    cast: speakers,
    excerpt,
    before: beforeOf(chunks, part - 1),
    recap: library.previousRecap(db, bookId, request.chapterId),
    endpoint: { name: profile.name, model: profile.model, notes: layers.profile?.notes ?? "" },
    expressions: expressionNames(readEndpoints(db)),
  };
  const prompt = renderPrompt(template, vars);

  const reserve = tokenEstimate(excerpt, profile, Date.now(), { prompt: template }).reserve;
  assertWithinBudget(db, bookId, {
    kind: "scripting",
    cost: reserve,
    what: "this trial",
    requests: [{ endpoint: profile.id, cost: reserve }],
  });

  let sent: SentScript | null = null;
  let cost: number | null = null;
  const settle = (report: SentScript): void => {
    sent = report;
    // the book is gone if this throws; the answer still goes back to the page that asked
    try {
      const record = settleScript(
        db,
        profile,
        {
          bookId,
          chapterUid: uid,
          label: `Prompt trial · part ${part}/${chunks.length}`,
          held: reserve,
        },
        report,
      );
      cost = report.usage ? record.cost : null;
    } catch {
      cost = null;
    }
  };

  const started = performance.now();
  let answer: ScriptAnswer = { lines: [] };
  let error: string | undefined;
  try {
    answer = await provider.script({
      title: chapter.title,
      text: excerpt,
      signal,
      target: scriptTarget(db, profile),
      cast: speakers.map((s) => s.name),
      prompt,
      lenient: true,
      sent: settle,
    });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    if (!(e instanceof ProviderError)) throw e;
    error = e.message;
  }
  const ms = Math.round(performance.now() - started);
  const usage = (sent as SentScript | null)?.usage ?? null;
  const { lines } = answer;

  return {
    prompt,
    part,
    parts: chunks.length,
    excerpt,
    lines: lines.map((l) => ({
      type: l.type,
      speaker: l.speaker,
      text: l.text,
      ...(l.direction ? { direction: l.direction } : {}),
      ...(l.tags?.length ? { tags: l.tags } : {}),
    })),
    fidelity: fidelity(excerpt, lines),
    cast: answer.cast ?? [],
    ...(answer.recap ? { recap: answer.recap } : {}),
    ms,
    usage: usage && {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens ?? null,
    },
    cost,
    ...(error !== undefined ? { error } : {}),
  };
}
