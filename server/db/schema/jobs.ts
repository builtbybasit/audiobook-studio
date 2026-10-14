// The queue: one job per chapter of work. `reserved` is a column because the budget gate sums it
// across unfinished jobs; the run detail is read whole, so it is JSON.
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
    /** null for a whole-book job; an FK: a job follows renumbering and dies with its chapter */
    chapterId: integer("chapter_id"),
    label: text("label").notNull(),
    status: text("status").$type<JobStatus>().notNull(),
    progress: real("progress").notNull().default(0),
    queuedAt: integer("queued_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    cancelled: integer("cancelled", { mode: "boolean" }).notNull().default(false),
    waitingReason: text("waiting_reason"),
    /** raised by "Run next"; the claim takes the highest first, then the oldest (`claimNext`) */
    priority: integer("priority").notNull().default(0),

    /** shared by every job from one press, for "cancel the rest" and "retry failures" */
    bulkId: integer("bulk_id"),
    /** in the words the button used */
    bulkOp: text("bulk_op"),
    bulkIndex: integer("bulk_index"),
    bulkTotal: integer("bulk_total"),
    /** the narration scope, or the scripting run's preservation setting */
    bulkScope: text("bulk_scope"),

    /** Held against the book's cap at undiscounted rates; released when the job finishes. */
    reserved: real("reserved").notNull().default(0),
    /** the planned cost estimate, for reconciliation */
    estimated: real("estimated"),

    /** the Queue page's detail, and everything a retry needs */
    run: text("run", { mode: "json" }).$type<
      Pick<Job, "scriptRun" | "narrationRun" | "exportRun" | "checkRun">
    >(),

    droppedEvents: integer("dropped_events").notNull().default(0),

    /**
     * `kind:book:chapter` while queued or running, null after. Its unique index stops the same
     * work being queued twice; NULLs are distinct, so finished jobs never collide.
     */
    activeKey: text("active_key"),
    /** starts the process died during; a clean stop gives its start back (`handBack`) */
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    uniqueIndex("jobs_active_key").on(t.activeKey),
    // A null `chapter_id` satisfies the FK, as a whole-book job needs.
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
    /** the budget gate's sum */
    index("jobs_reserved").on(t.bookId, t.status),
  ],
);

/** A job's log: append-only and unbounded; `jobs.dropped_events` counts what was trimmed. */
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
