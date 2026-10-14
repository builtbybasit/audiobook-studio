// Tries a draft prompt on one real chunk, built as a run builds it (`~/jobs/scripting`). Nothing is
// written; a refused answer is shown, not raised. The request is real: held to the book's budget at
// worst case and priced into its ledger.
import type {
  BookPrompt,
  ProfilePrompt,
  PromptTemplate,
  PromptTrialRequest,
  PromptTrialResult,
} from "@/types";
import {
  lineEffectsOf,
  notesProblems,
  promptProblems,
  renderPrompt,
  resolvePrompt,
  type PromptVars,
} from "@/lib/prompt";
import { expressionNames } from "@/lib/expressions";
import { tokenEstimate } from "@/lib/scripting";
import { readChapterCast, readSpeakers } from "~/db/cast";
import type { Db } from "~/db/client";
import { listEffects } from "~/db/effects";
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
import { dispatch } from "~/usage/dispatch";

/** The draft when sent (`null` included), else what is saved. */
const draftOr = <T>(draft: T | null | undefined, saved: T | null | undefined): T | null =>
  draft !== undefined ? draft : (saved ?? null);

/**
 * Send one chunk with the prompt the drafts resolve to. A paused endpoint may still be tried;
 * nothing is priced for a request aborted halfway.
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
  const text = plainText(body);
  const chunks = chunksOf(text, profile);
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

  const speakers = readSpeakers(db, bookId);
  const listed = readChapterCast(db, bookId, request.chapterId, text);
  const vars: PromptVars = {
    book: { title: book.title, author: book.author ?? "", notes: layers.book?.notes ?? "" },
    chapter: {
      title: chapter.title,
      // as `scriptingHandler` tells it: the id for a skipped chapter
      number: library.readingNumber(db, bookId, request.chapterId) ?? request.chapterId,
    },
    part,
    parts: chunks.length,
    cast: listed,
    excerpt,
    before: beforeOf(chunks, part - 1),
    recap: library.previousRecap(db, bookId, request.chapterId),
    endpoint: { name: profile.name, model: profile.model, notes: layers.profile?.notes ?? "" },
    expressions: expressionNames(readEndpoints(db)),
    lineEffects: lineEffectsOf(listEffects(db)),
  };
  const prompt = renderPrompt(template, vars);

  const reserve = tokenEstimate(excerpt, profile, Date.now(), { prompt: template }).reserve;
  assertWithinBudget(db, bookId, {
    kind: "scripting",
    cost: reserve,
    what: "this trial",
    requests: [{ endpoint: profile.id, cost: reserve }],
  });

  // Held to the profile's daily limit; a book removed meanwhile gets no ledger row.
  const money = dispatch(db, {
    kind: "scripting",
    endpoint: profile,
    work: {
      bookId,
      chapterUid: uid,
      label: `Prompt trial · part ${part}/${chunks.length}`,
    },
    hold: reserve,
  });
  let sent: SentScript | null = null;
  let cost: number | null = null;
  const settle = (report: SentScript): void => {
    sent = report;
    const record = money.sent(report);
    cost = report.usage && record ? record.cost : null;
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
  } finally {
    money.release();
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
      ...(l.effects?.length ? { effects: l.effects } : {}),
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
