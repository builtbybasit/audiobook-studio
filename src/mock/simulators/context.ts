// What a simulator is allowed to reach for.
//
// The simulators fake an endpoint, not the application: they read and write the entities the store
// owns, but they never see the store itself. Each one declares the slice of it that it needs, so
// what a timer loop can touch is visible at the top of the file rather than implied by `this`, and
// the store stays the only place where reactive state is defined.
import type { Job, JobStatus, ToastOptions } from "@/types";

/** Every simulator settles jobs and reports what happened the same way. */
export interface SimulatorContext {
  /** mark a job done / failed / cancelled, once */
  finishJob(job: Job, status: JobStatus): void;
  toast(msg: string, opts?: ToastOptions): string;
  /**
   * True once the world this run was started against is gone — a demo reset, or another scenario
   * applied over it. A stale run stops where it is and writes nothing: the job it was settling, the
   * chapter it was rendering and the export it was building all belong to a world that no longer
   * exists, and a late callback that "finishes" one of them would be reporting on someone else's
   * book. Checked at every point a run could continue, which is what makes switching scenarios safe
   * while work is in flight.
   */
  stale(): boolean;
}
