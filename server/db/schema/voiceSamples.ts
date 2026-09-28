// The recordings a cloned voice was made from, kept with the voice.
//
// A clone is made in one request and the provider keeps only the voice; without these rows the
// recordings would be gone the moment the upload finished, and a voice could never travel with a
// book's script to someone who has to make it again on their own account.
//
// **Neither table points at `voices`.** Saving the endpoints clears every endpoint and voice row
// and lays the whole configuration down again (`server/db/endpoints.ts`), so a cascade from
// `voices` would delete every recording on every save. The two are tied to a voice by value —
// `(endpoint_id, voice_id)`, as a character's `VoiceRef` is — and `saveEndpoints` reconciles them
// against what was saved: see `reconcileClones` in `server/db/voiceSamples.ts`.
import { foreignKey, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { RecordingFormat } from "~/providers/clone";

/**
 * A voice whose recordings are kept: one made here, or one made before recordings were kept and
 * given them afterwards.
 */
export const clonedVoices = sqliteTable(
  "cloned_voices",
  {
    endpointId: text("endpoint_id").notNull(),
    voiceId: text("voice_id").notNull(),
    /** what the voice was called when it was made */
    title: text("title").notNull(),
    /** epoch ms the recordings were kept */
    madeAt: integer("made_at").notNull(),
    /** epoch ms the person ticked the box, and the sentence they ticked */
    consentAt: integer("consent_at").notNull(),
    consentText: text("consent_text").notNull(),
    /**
     * A saved configuration has held this voice. Until one has, the voice is the page's to add — the
     * clone answers before the page saves it — so a save without it is not yet a removal.
     */
    attached: integer("attached", { mode: "boolean" }).notNull().default(false),
    /**
     * Epoch ms a save first went without this attached voice. Removing a voice or an endpoint on
     * the page offers Undo, and a settings import can drop a voice and bring it back, so a missing
     * voice keeps its recordings for a grace period and gets them back when it returns; a later
     * save after the grace period removes them.
     */
    missingSince: integer("missing_since"),
    /**
     * Epoch ms the person forgot these recordings. Hidden from every read at once, restorable by
     * the forget's Undo until a save after the grace period removes them.
     */
    forgottenAt: integer("forgotten_at"),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.voiceId] })],
);

/** One kept recording. The bytes are on disk under `VOICE_DIR`, named by their hash. */
export const voiceSamples = sqliteTable(
  "voice_samples",
  {
    endpointId: text("endpoint_id").notNull(),
    voiceId: text("voice_id").notNull(),
    /** `<sha>.<ext>` — the name on disk, and the one a url asks for */
    file: text("file").notNull(),
    /** the name the person's file had, for showing */
    name: text("name").notNull(),
    /** what the bytes say they are, which is what they are served as */
    format: text("format").$type<RecordingFormat>().notNull(),
    bytes: integer("bytes").notNull(),
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
