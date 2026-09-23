// Every read and write the endpoints make: speech endpoints, scripting profiles and the credential
// registry they point at.
//
// The three are configured together on one page and saved together, so they are written together:
// `replaceEndpoints` clears what is there and lays the whole configuration down again in the
// caller's transaction. Nothing else in the schema points at an endpoint by key — a character holds
// `<endpointId>/<voiceId>` as text, and the requests ledger keeps the id it was made under — so
// replacing the rows moves nothing and orphans nothing. What an endpoint owns (voices, the rate
// schedule, promotions, expression tags) cascades with it.
import { asc, eq, sql } from "drizzle-orm";

import type { Endpoint, Profile } from "@/types";
import type { Credential } from "@/lib/credentials";
import type { Db, Tx } from "~/db/client";
import * as rows from "~/db/rows";
import {
  credentials,
  endpoints,
  expressionTags,
  promotions,
  rateWindows,
  settings,
  voices,
} from "~/db/schema";

/** The whole configuration the Endpoints page edits. */
export interface EndpointConfig {
  endpoints: rows.EndpointSettings[];
  profiles: Profile[];
  credentials: Credential[];
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
  e: rows.EndpointSettings,
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

/** In the order they were saved in: a save inserts them in the page's order, and rowid keeps it. */
export function readCredentials(db: Db | Tx): Credential[] {
  return db
    .select()
    .from(credentials)
    .orderBy(sql`rowid`)
    .all()
    .map((c) => ({ id: c.id, label: c.label, note: c.note }));
}

/**
 * Whether anybody has ever saved endpoints to this server.
 *
 * An empty table cannot say it: a fresh database has no endpoints, and neither does one whose
 * operator removed every one of them. The first is the browser's cue to hand over the
 * configuration it starts with; the second must stay empty. So the first save leaves a mark.
 */
export function endpointsSaved(db: Db | Tx): boolean {
  return !!db.select().from(settings).where(eq(settings.key, "endpoints")).get();
}

export function readEndpointConfig(db: Db | Tx): EndpointConfig {
  return {
    endpoints: readEndpoints(db),
    profiles: readProfiles(db),
    credentials: readCredentials(db),
  };
}

/**
 * The key a real provider is called with, read at the moment of the request — never copied onto a
 * job, so a key changed or forgotten on the Endpoints page is the one the next request uses.
 * `kind` keeps a speech endpoint and a scripting profile that share an id apart.
 */
export function readEndpointKey(db: Db | Tx, kind: "tts" | "scripting", id: string): string | null {
  const row = db
    .select({ apiKey: endpoints.apiKey })
    .from(endpoints)
    .where(eq(endpoints.id, kind === "scripting" ? rows.profileKey(id) : id))
    .get();
  return row?.apiKey || null;
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
  tx.insert(settings)
    .values({ key: "endpoints", value: { savedAt: Date.now() } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { savedAt: Date.now() } } })
    .run();
}
