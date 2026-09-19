// The queue: one job per chapter of work, whatever kind it is.
//
// `reserved` is a column rather than a field inside the run detail because it is **summed across
// unfinished jobs** to answer "what is this book's budget already committed to". The store's rule
// is that two runs which each fit the remaining cap must not both start and overshoot together, so
// the figure a gate reads has to be a cheap aggregate over rows, not a JSON parse per job.
//
// The rest of the run detail is three mutually exclusive shapes — a scripting run, a narration run,
// a build — and it is read whole, by the one page that opens a job up. That is a document, so it is
// stored as one.
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { Job, JobKind, JobStatus } from "@/types";
import { books, chapters } from "~/db/schema/library";

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey(),
    kind: text("kind").$type<JobKind>().notNull(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade", onUpdate: "cascade" }),
    /**
     * The chapter this job is for, or null for a job about the whole book, such as a build.
     *
     * A real reference rather than a loose number, because a job is *live state*: it follows the
     * chapter when a removed volume renumbers the book, and it ends with the chapter when the
     * chapter goes. A queued narration of chapter 2 that became chapter 1 underneath it would
     * otherwise run on the wrong chapter, and a job for a chapter that no longer exists is one the
     * Queue can neither open nor retry. What was *spent* on that work is not lost with it: the
     * ledger keeps its own record, which is the one that is not allowed to move.
     */
    chapterId: integer("chapter_id"),
    label: text("label").notNull(),
    status: text("status").$type<JobStatus>().notNull(),
    progress: real("progress").notNull().default(0),
    queuedAt: integer("queued_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    waitingReason: text("waiting_reason"),

    /**
     * The bulk run this job belongs to. Every chapter asked for in one press shares an id, which is
     * what makes "cancel the rest of this run" and "retry this run's failures" possible without the
     * queue guessing.
     */
    bulkId: integer("bulk_id"),
    /** what was asked for, in the words the button used */
    bulkOp: text("bulk_op"),
    bulkIndex: integer("bulk_index"),
    bulkTotal: integer("bulk_total"),
    /** the narration scope, or the scripting run's preservation setting */
    bulkScope: text("bulk_scope"),

    /**
     * What this job is holding against the book's cap while it runs, at **undiscounted** rates.
     *
     * Released when the job finishes rather than clip by clip, so the reservation only ever errs
     * towards holding too much back.
     */
    reserved: real("reserved").notNull().default(0),
    /** what this run was estimated to cost when it was planned, for the reconciliation afterwards */
    estimated: real("estimated"),

    /** the live detail the Queue page opens up, and everything a retry needs to run it again */
    run: text("run", { mode: "json" }).$type<
      Pick<Job, "scriptRun" | "narrationRun" | "exportRun">
    >(),

    /** events this session's simulator observed but could not keep */
    droppedEvents: integer("dropped_events").notNull().default(0),

    /**
     * `kind:book:chapter` while the job is queued or running, null once it has finished.
     *
     * The unique index below is the duplicate-request rule: the same work cannot be queued twice,
     * and it is the database that says so rather than a check a second request could slip past.
     * NULLs are distinct to SQLite, so finished jobs never collide.
     */
    activeKey: text("active_key"),
    /** how many times this job has been started; a restart that finds it running starts it again */
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    uniqueIndex("jobs_active_key").on(t.activeKey),
    // `chapter_id` is nullable, and a foreign key with a null in it is satisfied by definition —
    // which is exactly what a whole-book job needs.
    foreignKey({
      columns: [t.bookId, t.chapterId],
      foreignColumns: [chapters.bookId, chapters.id],
      name: "jobs_chapter_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("jobs_book").on(t.bookId, t.id),
    index("jobs_status").on(t.status),
    index("jobs_bulk").on(t.bulkId, t.bulkIndex),
    /** the budget gate's question: what are this book's unfinished jobs holding */
    index("jobs_reserved").on(t.bookId, t.status),
  ],
);

/**
 * One thing that happened while a job ran.
 *
 * A separate table because it is append-only and unbounded — a build of a 214-chapter serial logs
 * per file — and because `dropped_events` on the job is how a trimmed log stays honest about what
 * it no longer has.
 */
export const jobEvents = sqliteTable(
  "job_events",
  {
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade", onUpdate: "cascade" }),
    id: integer("id").notNull(),
    at: integer("at").notNull(),
    level: text("level").$type<"info" | "warning" | "error">().notNull(),
    message: text("message").notNull(),
    detail: text("detail", { mode: "json" }).$type<Record<string, string | number>>(),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.id] }), index("job_events_time").on(t.jobId, t.at)],
);
