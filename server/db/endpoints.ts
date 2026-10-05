// Every read and write the endpoints make: speech endpoints, scripting profiles, transcription
// endpoints and the credential registry they point at.
//
// They are configured together on one page and saved together, so they are written together:
// `replaceEndpoints` clears what is there and lays the whole configuration down again in the
// caller's transaction. Nothing else in the schema points at an endpoint by key — a character holds
// `<endpointId>/<voiceId>` as text, and the requests ledger keeps the id it was made under — so
// replacing the rows moves nothing and orphans nothing. What an endpoint owns (voices, the rate
// schedule, promotions, expression tags) cascades with it. The library's default scripting prompt
// is edited on the same page and saved in the same write, though it lives in `settings`, and so are
// the scripting settings (`script`: which profile runs go to), which the Scripting page picks.
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
  /**
   * Always there in a read; in a write, left out keeps the ones stored, so a page from before
   * there were any cannot remove them by saving.
   */
  transcribers?: Transcriber[];
  credentials: Credential[];
  /**
   * The library's default scripting prompt; null is the built-in one. Always there in a read; in a
   * write, left out keeps the one stored, so a save that never showed it cannot reset it.
   */
  prompt?: PromptTemplate | null;
  /**
   * The scripting settings: the profile runs go to, and the switches beside it. Always there in a
   * read, naming only a profile that is saved; in a write, left out keeps the ones stored.
   */
  script?: ScriptSettings;
}

/**
 * The credential registry.
 *
 * Endpoints point at it by id, so it has to exist before any of them do. Names only — the secret
 * itself is not in this schema.
 */
export function writeCredentials(db: Db | Tx, registry: readonly Credential[]): void {
  for (const c of registry)
    db.insert(credentials).values({ id: c.id, label: c.label, note: c.note }).run();
}

/** An endpoint and everything hanging off it: voices, the schedule, promotions, expression tags. */
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

/** The rate card's rows. Shared, because a speech rate goes on discount exactly as a token rate does. */
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

/** One speech endpoint, or undefined when there is none by that id — or it is a scripting profile. */
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

/** The transcription endpoint by that id, or else the first one switched on; undefined for none. */
export function readTranscriber(db: Db | Tx, id?: string): Transcriber | undefined {
  const all = readTranscribers(db);
  return id ? all.find((t) => t.id === id) : all.find((t) => t.enabled);
}

/** In the order they were saved in: a save inserts them in the page's order, and rowid keeps it. */
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
 * The key a real provider is called with, read at the moment of the request — never copied onto a
 * job, so a key changed or forgotten on the Endpoints page is the one the next request uses.
 * `kind` keeps endpoints of different kinds that share an id apart.
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

/**
 * What a save leaves an endpoint's key as. The key is write-only, so a page that never saw it
 * sends nothing for it, and that has to mean "keep it" rather than "forget it"; `""` forgets it.
 */
function keyAfterSave(sent: string | undefined, kept: string | null | undefined): string | null {
  if (sent === undefined) return kept ?? null;
  return sent.trim() || null;
}

/** Lay the whole configuration down in place of what was there. Call inside a transaction. */
export function replaceEndpoints(tx: Tx, config: EndpointConfig): void {
  // keys by row id, read before the rows go, so a save that did not mention a key keeps it
  const kept = new Map(
    tx
      .select({ id: endpoints.id, apiKey: endpoints.apiKey })
      .from(endpoints)
      .all()
      .map((r) => [r.id, r.apiKey]),
  );
  // a save from a page that never had transcription endpoints keeps the ones stored
  const transcribers = config.transcribers ?? readTranscribers(tx);
  // the children cascade with their endpoint, and an endpoint's credential is set null as it goes
  tx.delete(endpoints).run();
  tx.delete(credentials).run();
  writeCredentials(tx, config.credentials);
  config.endpoints.forEach((e, i) =>
    writeEndpoint(tx, e, i, keyAfterSave(e.apiKey, kept.get(e.id))),
  );
  config.profiles.forEach((p, i) =>
    writeProfile(tx, p, i, keyAfterSave(p.apiKey, kept.get(rows.profileKey(p.id)))),
  );
  transcribers.forEach((t, i) =>
    writeTranscriber(tx, t, i, keyAfterSave(t.apiKey, kept.get(rows.transcriberKey(t.id)))),
  );
  if (config.prompt !== undefined) writeLibraryPrompt(tx, config.prompt);
  if (config.script !== undefined) writeScriptSettings(tx, config.script);
}
