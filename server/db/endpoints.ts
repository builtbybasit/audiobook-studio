// Speech endpoints, scripting profiles, transcription endpoints and credentials, saved together:
// `replaceEndpoints` lays the whole configuration down again. Nothing references an endpoint by
// foreign key (characters and the ledger hold ids as text), so replacing rows orphans nothing.
// The default scripting prompt and scripting settings live in `settings` but save in this write.
import { asc, eq, sql } from "drizzle-orm";

import type {
  Credential,
  Endpoint,
  EndpointKind,
  Profile,
  PromptTemplate,
  ScriptSettings,
  Transcriber,
} from "@/types";
import type { StoredEndpoint } from "@/lib/endpointTelemetry";
import type { Db, Tx } from "~/db/client";
import * as rows from "~/db/rows";
import {
  readLibraryPrompt,
  readScriptSettings,
  writeLibraryPrompt,
  writeScriptSettings,
} from "~/db/settings";
import {
  credentials,
  endpoints,
  expressionTags,
  promotions,
  rateWindows,
  voices,
} from "~/db/schema";

/** The whole configuration the Endpoints page edits. */
export interface EndpointConfig {
  endpoints: StoredEndpoint[];
  profiles: Profile[];
  /** Always in a read; left out of a write keeps the stored ones. */
  transcribers?: Transcriber[];
  credentials: Credential[];
  /** The default scripting prompt; null is the built-in one. Left out of a write keeps it. */
  prompt?: PromptTemplate | null;
  /** A read names only a saved profile; left out of a write keeps the stored ones. */
  script?: ScriptSettings;
}

/** Write before the endpoints that point at it. Names only; secrets are not in this schema. */
export function writeCredentials(db: Db | Tx, registry: readonly Credential[]): void {
  for (const c of registry)
    db.insert(credentials).values({ id: c.id, label: c.label, note: c.note }).run();
}

/** An endpoint with its voices, schedule, promotions and expression tags. */
export function writeEndpoint(
  db: Db | Tx,
  e: StoredEndpoint,
  position: number,
  apiKey: string | null = null,
): void {
  db.insert(endpoints)
    .values(rows.endpointValues(e, position, apiKey))
    .run();
  e.voices.forEach((v, i) =>
    db
      .insert(voices)
      .values(rows.voiceValues(e.id, v, i))
      .run(),
  );
  writeCard(db, e.id, e.pricing?.windows ?? [], e.pricing?.promotions ?? []);
  (e.expressions?.tags ?? []).forEach((t, i) =>
    db
      .insert(expressionTags)
      .values(rows.expressionTagValues(e.id, t, i))
      .run(),
  );
}

export function writeProfile(
  db: Db | Tx,
  p: Profile,
  position: number,
  apiKey: string | null = null,
): void {
  db.insert(endpoints)
    .values(rows.profileValues(p, position, apiKey))
    .run();
  writeCard(db, rows.profileKey(p.id), p.pricing?.windows ?? [], p.pricing?.promotions ?? []);
}

export function writeTranscriber(
  db: Db | Tx,
  t: Transcriber,
  position: number,
  apiKey: string | null = null,
): void {
  db.insert(endpoints)
    .values(rows.transcriberValues(t, position, apiKey))
    .run();
  writeCard(db, rows.transcriberKey(t.id), t.pricing?.windows ?? [], t.pricing?.promotions ?? []);
}

/** Shared: a speech rate goes on discount exactly as a token rate does. */
function writeCard(
  db: Db | Tx,
  endpointId: string,
  windows: NonNullable<Endpoint["pricing"]>["windows"],
  promos: NonNullable<Endpoint["pricing"]>["promotions"],
): void {
  windows.forEach((w, i) =>
    db
      .insert(rateWindows)
      .values(rows.rateWindowValues(endpointId, w, i))
      .run(),
  );
  promos.forEach((p, i) =>
    db
      .insert(promotions)
      .values(rows.promotionValues(endpointId, p, i))
      .run(),
  );
}

function partsOf(db: Db | Tx, endpointId: string): rows.EndpointParts {
  return {
    voices: db.select().from(voices).where(eq(voices.endpointId, endpointId)).all(),
    windows: db.select().from(rateWindows).where(eq(rateWindows.endpointId, endpointId)).all(),
    promotions: db.select().from(promotions).where(eq(promotions.endpointId, endpointId)).all(),
    tags: db.select().from(expressionTags).where(eq(expressionTags.endpointId, endpointId)).all(),
  };
}

export function readEndpoints(db: Db | Tx): Endpoint[] {
  return db
    .select()
    .from(endpoints)
    .where(eq(endpoints.kind, "tts"))
    .orderBy(asc(endpoints.position))
    .all()
    .map((row) => rows.toEndpoint(row, partsOf(db, row.id)));
}

/** Speech endpoints only; a scripting profile's id reads as undefined. */
export function readEndpoint(db: Db | Tx, id: string): Endpoint | undefined {
  const row = db.select().from(endpoints).where(eq(endpoints.id, id)).get();
  return row?.kind === "tts" ? rows.toEndpoint(row, partsOf(db, row.id)) : undefined;
}

export function readProfiles(db: Db | Tx): Profile[] {
  return db
    .select()
    .from(endpoints)
    .where(eq(endpoints.kind, "scripting"))
    .orderBy(asc(endpoints.position))
    .all()
    .map((row) => rows.toProfile(row, partsOf(db, row.id)));
}

export function readTranscribers(db: Db | Tx): Transcriber[] {
  return db
    .select()
    .from(endpoints)
    .where(eq(endpoints.kind, "transcription"))
    .orderBy(asc(endpoints.position))
    .all()
    .map((row) => rows.toTranscriber(row, partsOf(db, row.id)));
}

/** By id, else the first one switched on. */
export function readTranscriber(db: Db | Tx, id?: string): Transcriber | undefined {
  const all = readTranscribers(db);
  return id ? all.find((t) => t.id === id) : all.find((t) => t.enabled);
}

/** In saved order, which rowid keeps. */
export function readCredentials(db: Db | Tx): Credential[] {
  return db
    .select()
    .from(credentials)
    .orderBy(sql`rowid`)
    .all()
    .map((c) => ({ id: c.id, label: c.label, note: c.note }));
}

export function readEndpointConfig(db: Db | Tx): EndpointConfig {
  const profiles = readProfiles(db);
  const script = readScriptSettings(db);
  // a save that left the settings out may have removed the profile they chose
  if (script.profile != null && !profiles.some((p) => p.id === script.profile))
    script.profile = null;
  return {
    endpoints: readEndpoints(db),
    profiles,
    transcribers: readTranscribers(db),
    credentials: readCredentials(db),
    prompt: readLibraryPrompt(db),
    script,
  };
}

/**
 * Read at request time, never copied onto a job, so the next request uses the current key.
 * `kind` separates endpoints of different kinds that share an id.
 */
export function readEndpointKey(db: Db | Tx, kind: EndpointKind, id: string): string | null {
  const row = db
    .select({ apiKey: endpoints.apiKey })
    .from(endpoints)
    .where(eq(endpoints.id, rowId(kind, id)))
    .get();
  return row?.apiKey || null;
}

/** The row an endpoint of `kind` is kept under; see `PROFILE_KEY`. */
function rowId(kind: EndpointKind, id: string): string {
  switch (kind) {
    case "tts":
      return id;
    case "scripting":
      return rows.profileKey(id);
    case "transcription":
      return rows.transcriberKey(id);
  }
}

type Kept = { apiKey: string | null; baseUrl: string };

/**
 * The key is write-only: undefined keeps it, `""` forgets it. A new base URL without a new key
 * forgets it too, so a save can't point a stored key at another server.
 */
function keyAfterSave(sent: { apiKey?: string; baseUrl: string }, kept: Kept | undefined) {
  if (sent.apiKey !== undefined) return sent.apiKey.trim() || null;
  return kept?.baseUrl === sent.baseUrl ? kept.apiKey : null;
}

/** Call inside a transaction. */
export function replaceEndpoints(tx: Tx, config: EndpointConfig): void {
  // read before the rows go, so a save that did not mention a key keeps it
  const kept = new Map(
    tx
      .select({ id: endpoints.id, apiKey: endpoints.apiKey, baseUrl: endpoints.baseUrl })
      .from(endpoints)
      .all()
      .map(({ id, ...k }) => [id, k]),
  );
  const transcribers = config.transcribers ?? readTranscribers(tx);
  // children cascade
  tx.delete(endpoints).run();
  tx.delete(credentials).run();
  writeCredentials(tx, config.credentials);
  config.endpoints.forEach((e, i) => writeEndpoint(tx, e, i, keyAfterSave(e, kept.get(e.id))));
  config.profiles.forEach((p, i) =>
    writeProfile(tx, p, i, keyAfterSave(p, kept.get(rows.profileKey(p.id)))),
  );
  transcribers.forEach((t, i) =>
    writeTranscriber(tx, t, i, keyAfterSave(t, kept.get(rows.transcriberKey(t.id)))),
  );
  if (config.prompt !== undefined) writeLibraryPrompt(tx, config.prompt);
  if (config.script !== undefined) writeScriptSettings(tx, config.script);
}
