// Speaker fingerprints of kept voice samples, keyed by the sample's file (named by its bytes), so a
// file kept for two voices is fingerprinted once and no voice save has to reconcile this table.
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sampleFingerprints = sqliteTable("sample_fingerprints", {
  /** `voice_samples.file`: `<sha>.<ext>` */
  file: text("file").primaryKey(),
  /** which fingerprinter made it (`FINGERPRINT_MODEL`); another model's rows are stale */
  model: text("model").notNull(),
  /** float32 little-endian, unit length */
  vector: blob("vector", { mode: "buffer" }).notNull(),
  /** epoch ms */
  madeAt: integer("made_at").notNull(),
});
