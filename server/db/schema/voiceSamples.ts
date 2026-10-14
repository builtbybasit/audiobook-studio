// The samples a cloned voice was made from (the provider keeps only the voice).
// Neither table points at `voices`: saving endpoints rewrites every voice row, so they key by value
// and are reconciled by `reconcileClones` in server/db/voiceSamples.ts.
import { foreignKey, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { SampleFormat } from "~/providers/clone";

export const clonedVoices = sqliteTable(
  "cloned_voices",
  {
    endpointId: text("endpoint_id").notNull(),
    voiceId: text("voice_id").notNull(),
    /** the voice's name when made */
    title: text("title").notNull(),
    /** epoch ms */
    madeAt: integer("made_at").notNull(),
    /** a saved configuration has held this voice; until then a save without it is not a removal */
    attached: integer("attached", { mode: "boolean" }).notNull().default(false),
    /** Epoch ms a save first lacked this voice; samples survive a grace period for Undo. */
    missingSince: integer("missing_since"),
    /** Epoch ms forgotten: hidden at once, restorable by Undo until the grace period ends. */
    forgottenAt: integer("forgotten_at"),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.voiceId] })],
);

/** One kept sample. The bytes are on disk under `VOICE_DIR`, named by their hash. */
export const voiceSamples = sqliteTable(
  "voice_samples",
  {
    endpointId: text("endpoint_id").notNull(),
    voiceId: text("voice_id").notNull(),
    /** `<sha>.<ext>`, the name on disk and in urls */
    file: text("file").notNull(),
    /** the uploaded file's name, for showing */
    name: text("name").notNull(),
    /** sniffed from the bytes; served as this */
    format: text("format").$type<SampleFormat>().notNull(),
    bytes: integer("bytes").notNull(),
    transcript: text("transcript"),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.endpointId, t.voiceId, t.file] }),
    foreignKey({
      columns: [t.endpointId, t.voiceId],
      foreignColumns: [clonedVoices.endpointId, clonedVoices.voiceId],
      name: "voice_samples_voice_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
  ],
);
