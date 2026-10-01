// lists.ts -- clients' request lists (Phase 3; meta-repo docs/dj-client-catalog.md
// section 5). Shared helpers, and the routes a signed-in client uses:
//
//   GET    /api/me                      who you are, and the lists you can edit
//   GET    /api/list?gig=<id>           one list (no gig = your own list before a booking)
//   POST   /api/requests                add a song (Would love by default) or a wish
//   PATCH  /api/requests/<id>           move it to another tier, set its moment or note
//   POST   /api/requests/reorder        put one tier in a new order
//   DELETE /api/requests/<id>           take it off the list
//   POST   /api/misses                  a search that found nothing (no identity kept)
//
// A client edits only their own list, only while it is open: a gig's list closes
// at its close date or when the gig is no longer 'planning'. Members of one gig
// see each other's lists. The owner (OWNER_EMAIL) sees everything, in /dj.
// Every write is recorded in `changes`, the feed the Living Room mini pulls.

import { HttpError, json, readJson } from "./http.ts";
import { VERSION } from "./version.ts";
import type { Role, Tier } from "./merge.ts";

export interface ListsEnv {
  DB: D1Database;
  OWNER_EMAIL?: string;
}

export const TIERS: Tier[] = ["must", "want", "dnp", "wish"];
export const ROLES: Role[] = ["host", "planner", "guest"];
export const STATUSES = ["planning", "locked", "played", "archived"];
export const MOMENTS = [
  "Entrance", "Ceremony", "Cocktail hour", "Dinner", "First dance", "Parent dances",
  "Hora", "Cake cutting", "Last song", "Other",
];
export const DEFAULT_MUST_CAP = 20;
export const MAX_ITEMS_PER_LIST = 400;
export const MAX_MISSES_PER_DAY = 1000;
const LIMIT = { artist: 200, title: 200, mix: 200, note: 500, key: 300, version: 60 };
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;
const VERSION_RE = /^\d{1,12}:\S{1,40}$/;

export interface Gig {
  id: string;
  name: string;
  date: string | null;
  venue: string | null;
  status: string;
  requests_close_at: string | null;
  must_cap: number;
  created_at: string;
  updated_at: string;
}

export interface RequestRow {
  id: string;
  gig_id: string | null;
  email: string;
  song_key: string | null;
  version_key: string | null;
  artist: string;
  title: string;
  mix: string | null;
  tier: Tier;
  rank: number;
  moment: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------- helpers

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();

export function cleanEmail(v: unknown): string {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(e) || e.length > 254) throw new HttpError(400, "That doesn't look like an email address.");
  return e;
}

export function isOwner(env: ListsEnv, email: string): boolean {
  const owner = (env.OWNER_EMAIL ?? "").trim().toLowerCase();
  return Boolean(owner) && email === owner;
}

// Optional text: trimmed, at most `max` characters, null when empty.
export function optText(v: unknown, max: number, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be text.`);
  const t = v.trim().replace(/\s+/g, " ");
  if (t.length > max) throw new HttpError(400, `${field} can be at most ${max} characters.`);
  return t || null;
}

export function reqText(v: unknown, max: number, field: string): string {
  const t = optText(v, max, field);
  if (!t) throw new HttpError(400, `${field} is required.`);
  return t;
}

// A note keeps its line breaks.
function noteText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "The note must be text.");
  const t = v.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > LIMIT.note) throw new HttpError(400, `A note can be at most ${LIMIT.note} characters.`);
  return t || null;
}

function moment(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !MOMENTS.includes(v)) throw new HttpError(400, "Pick a moment from the list.");
  return v;
}

function tier(v: unknown, fallback?: Tier): Tier {
  if ((v === undefined || v === null) && fallback) return fallback;
  if (typeof v !== "string" || !TIERS.includes(v as Tier)) throw new HttpError(400, "Unknown tier.");
  return v as Tier;
}

export function listOpen(gig: Gig | null, now = nowIso()): boolean {
  if (!gig) return true;
  if (gig.status !== "planning") return false;
  return !gig.requests_close_at || now <= gig.requests_close_at;
}

export async function loadGig(db: D1Database, id: string): Promise<Gig | null> {
  return db.prepare("SELECT * FROM gigs WHERE id = ?").bind(id).first<Gig>();
}

export async function roleIn(db: D1Database, gigId: string, email: string): Promise<Role | null> {
  return db.prepare("SELECT role FROM members WHERE gig_id = ? AND email = ?").bind(gigId, email).first<Role>("role");
}

// One row in the feed. `detail` stays small: it is for a one-line summary.
export function change(
  db: D1Database,
  c: { entity: string; entity_id: string; op: string; gig_id: string | null; email: string | null; actor: string; detail?: unknown },
): D1PreparedStatement {
  const detail = c.detail === undefined ? null : JSON.stringify(c.detail).slice(0, 600);
  return db
    .prepare("INSERT INTO changes (entity, entity_id, op, gig_id, email, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(c.entity, c.entity_id, c.op, c.gig_id, c.email, c.actor, detail, nowIso());
}

export function publicRequest(r: RequestRow) {
  const { email: _email, deleted_at: _deleted, ...rest } = r;
  return rest;
}

const TIER_ORDER = "CASE tier WHEN 'must' THEN 0 WHEN 'want' THEN 1 WHEN 'dnp' THEN 2 ELSE 3 END";

export async function listRequests(db: D1Database, email: string, gigId: string | null): Promise<RequestRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM requests WHERE email = ? AND gig_id IS ? AND deleted_at IS NULL
       ORDER BY ${TIER_ORDER}, rank, created_at`,
    )
    .bind(email, gigId)
    .all<RequestRow>();
  return results;
}

async function tierCount(db: D1Database, email: string, gigId: string | null, t: Tier): Promise<number> {
  return (await db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE email = ? AND gig_id IS ? AND tier = ? AND deleted_at IS NULL")
    .bind(email, gigId, t)
    .first<number>("n")) ?? 0;
}

async function nextRank(db: D1Database, email: string, gigId: string | null, t: Tier): Promise<number> {
  const max = await db
    .prepare("SELECT MAX(rank) AS m FROM requests WHERE email = ? AND gig_id IS ? AND tier = ? AND deleted_at IS NULL")
    .bind(email, gigId, t)
    .first<number | null>("m");
  return (max ?? 0) + 1;
}

// The list the caller may change, or why not.
async function writableList(env: ListsEnv, email: string, gigId: string | null): Promise<Gig | null> {
  if (gigId === null) return null;                                  // your own list, always open
  const gig = await loadGig(env.DB, gigId);
  if (!gig || !(await roleIn(env.DB, gigId, email))) throw new HttpError(404, "No such list.");
  if (!listOpen(gig)) throw new HttpError(409, "Requests for this event are closed. Ask your DJ to reopen them.");
  return gig;
}

function gigParam(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 64) throw new HttpError(400, "Unknown list.");
  return v;
}

async function ownRequest(env: ListsEnv, email: string, id: string): Promise<{ row: RequestRow; gig: Gig | null }> {
  const row = await env.DB.prepare("SELECT * FROM requests WHERE id = ? AND deleted_at IS NULL").bind(id).first<RequestRow>();
  if (!row || row.email !== email) throw new HttpError(404, "No such request.");
  const gig = await writableList(env, email, row.gig_id);
  return { row, gig };
}

function mustCap(gig: Gig | null): number {
  return gig ? gig.must_cap : DEFAULT_MUST_CAP;
}

function fullMessage(cap: number): string {
  return `Must play is full (${cap}). Move one to Would love first.`;
}

// ---------------------------------------------------------------- routes

async function counts(db: D1Database, email: string, gigId: string | null) {
  const { results } = await db
    .prepare("SELECT tier, COUNT(*) AS n FROM requests WHERE email = ? AND gig_id IS ? AND deleted_at IS NULL GROUP BY tier")
    .bind(email, gigId)
    .all<{ tier: Tier; n: number }>();
  const out: Record<Tier, number> = { must: 0, want: 0, dnp: 0, wish: 0 };
  for (const r of results) out[r.tier] = r.n;
  return out;
}

function gigOut(g: Gig) {
  return {
    id: g.id, name: g.name, date: g.date, venue: g.venue, status: g.status,
    requests_close_at: g.requests_close_at, must_cap: g.must_cap,
  };
}

export async function me(env: ListsEnv, email: string): Promise<Response> {
  const { results } = await env.DB
    .prepare(
      `SELECT g.*, m.role AS role FROM members m JOIN gigs g ON g.id = m.gig_id
       WHERE m.email = ? AND g.status != 'archived' ORDER BY g.date IS NULL, g.date, g.name`,
    )
    .bind(email)
    .all<Gig & { role: Role }>();
  const now = nowIso();
  const lists = [];
  for (const g of results) {
    lists.push({ gig: gigOut(g), role: g.role, open: listOpen(g, now), counts: await counts(env.DB, email, g.id) });
  }
  const own = await counts(env.DB, email, null);
  lists.push({ gig: null, role: null, open: true, counts: own });
  return json(200, { email, version: VERSION, owner: isOwner(env, email), moments: MOMENTS, lists });
}

export async function getList(env: ListsEnv, email: string, url: URL): Promise<Response> {
  const gigId = gigParam(url.searchParams.get("gig"));
  if (gigId === null) {
    const mine = await listRequests(env.DB, email, null);
    return json(200, {
      list: { gig: null, role: null, open: true, must_cap: DEFAULT_MUST_CAP },
      mine: mine.map(publicRequest),
      others: [],
    });
  }
  const gig = await loadGig(env.DB, gigId);
  const role = gig ? await roleIn(env.DB, gigId, email) : null;
  if (!gig || !role) throw new HttpError(404, "No such list.");
  const { results: members } = await env.DB
    .prepare("SELECT email, name, role FROM members WHERE gig_id = ? ORDER BY role, created_at")
    .bind(gigId)
    .all<{ email: string; name: string | null; role: Role }>();
  const others = [];
  for (const m of members) {
    if (m.email === email) continue;
    others.push({ ...m, requests: (await listRequests(env.DB, m.email, gigId)).map(publicRequest) });
  }
  return json(200, {
    list: { gig: gigOut(gig), role, open: listOpen(gig), must_cap: gig.must_cap },
    mine: (await listRequests(env.DB, email, gigId)).map(publicRequest),
    others,
  });
}

export async function addRequest(env: ListsEnv, email: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  const gigId = gigParam(body.gig);
  const gig = await writableList(env, email, gigId);
  const t = tier(body.tier, body.song_key ? "want" : "wish");
  const wish = t === "wish";
  const songKey = wish ? null : reqText(body.song_key, LIMIT.key, "The song");
  const artist = wish ? optText(body.artist, LIMIT.artist, "The artist") ?? "" : reqText(body.artist, LIMIT.artist, "The artist");
  const title = reqText(body.title, LIMIT.title, "The title");
  const versionKey = wish ? null : optText(body.version_key, LIMIT.version, "The version");
  if (versionKey && !VERSION_RE.test(versionKey)) throw new HttpError(400, "Unknown version.");
  const mix = wish ? null : optText(body.mix, LIMIT.mix, "The mix");
  const m = moment(body.moment);
  const note = noteText(body.note);
  const db = env.DB;

  if (!wish) {
    const existing = await db
      .prepare("SELECT * FROM requests WHERE email = ? AND gig_id IS ? AND song_key = ? AND deleted_at IS NULL")
      .bind(email, gigId, songKey)
      .first<RequestRow>();
    if (existing) {
      if (versionKey && versionKey !== existing.version_key) {
        const at = nowIso();
        await db.batch([
          db.prepare("UPDATE requests SET version_key = ?, mix = ?, updated_at = ? WHERE id = ?").bind(versionKey, mix, at, existing.id),
          change(db, { entity: "request", entity_id: existing.id, op: "update", gig_id: gigId, email, actor: email,
            detail: { tier: existing.tier, artist: existing.artist, title: existing.title, version: versionKey } }),
        ]);
        existing.version_key = versionKey;
        existing.mix = mix;
        existing.updated_at = at;
      }
      return json(200, { request: publicRequest(existing), existed: true });
    }
  }
  const total = (await db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE email = ? AND gig_id IS ? AND deleted_at IS NULL")
    .bind(email, gigId)
    .first<number>("n")) ?? 0;
  if (total >= MAX_ITEMS_PER_LIST) throw new HttpError(409, `A list can hold ${MAX_ITEMS_PER_LIST} songs.`);
  if (t === "must" && (await tierCount(db, email, gigId, "must")) >= mustCap(gig)) {
    throw new HttpError(409, fullMessage(mustCap(gig)));
  }
  const at = nowIso();
  const row: RequestRow = {
    id: newId(), gig_id: gigId, email, song_key: songKey, version_key: versionKey, artist, title, mix,
    tier: t, rank: await nextRank(db, email, gigId, t), moment: m, note, created_at: at, updated_at: at, deleted_at: null,
  };
  await db.batch([
    db.prepare(
      `INSERT INTO requests (id, gig_id, email, song_key, version_key, artist, title, mix, tier, rank, moment, note,
                             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.id, gigId, email, songKey, versionKey, artist, title, mix, t, row.rank, m, note, at, at),
    change(db, { entity: "request", entity_id: row.id, op: "add", gig_id: gigId, email, actor: email,
      detail: { tier: t, artist, title } }),
  ]);
  return json(201, { request: publicRequest(row), existed: false });
}

export async function patchRequest(env: ListsEnv, email: string, id: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  const { row, gig } = await ownRequest(env, email, id);
  const db = env.DB;
  const next = { ...row };
  let op = "update";
  if (body.tier !== undefined) {
    const t = tier(body.tier);
    if ((t === "wish") !== (row.tier === "wish")) throw new HttpError(400, "A wish stays a wish.");
    if (t !== row.tier) {
      if (t === "must" && (await tierCount(db, email, row.gig_id, "must")) >= mustCap(gig)) {
        throw new HttpError(409, fullMessage(mustCap(gig)));
      }
      next.tier = t;
      next.rank = await nextRank(db, email, row.gig_id, t);
      op = "move";
    }
  }
  if (body.moment !== undefined) next.moment = moment(body.moment);
  if (body.note !== undefined) next.note = noteText(body.note);
  if (body.version_key !== undefined && row.tier !== "wish") {
    const v = optText(body.version_key, LIMIT.version, "The version");
    if (v && !VERSION_RE.test(v)) throw new HttpError(400, "Unknown version.");
    next.version_key = v;
    next.mix = v ? optText(body.mix, LIMIT.mix, "The mix") : null;
  }
  next.updated_at = nowIso();
  await db.batch([
    db.prepare("UPDATE requests SET tier = ?, rank = ?, moment = ?, note = ?, version_key = ?, mix = ?, updated_at = ? WHERE id = ?")
      .bind(next.tier, next.rank, next.moment, next.note, next.version_key, next.mix, next.updated_at, id),
    change(db, { entity: "request", entity_id: id, op, gig_id: row.gig_id, email, actor: email,
      detail: { tier: next.tier, from: row.tier, artist: row.artist, title: row.title } }),
  ]);
  return json(200, { request: publicRequest(next) });
}

export async function reorder(env: ListsEnv, email: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  const gigId = gigParam(body.gig);
  await writableList(env, email, gigId);
  const t = tier(body.tier);
  const ids = Array.isArray(body.ids) ? body.ids : null;
  if (!ids || ids.some((x) => typeof x !== "string")) throw new HttpError(400, "Send the tier's ids in their new order.");
  const db = env.DB;
  const { results } = await db
    .prepare("SELECT id FROM requests WHERE email = ? AND gig_id IS ? AND tier = ? AND deleted_at IS NULL")
    .bind(email, gigId, t)
    .all<{ id: string }>();
  const have = new Set(results.map((r) => r.id));
  if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((x) => have.has(x as string))) {
    throw new HttpError(409, "The list changed meanwhile. Reload it and try again.");
  }
  const at = nowIso();
  await db.batch([
    ...ids.map((x, i) => db.prepare("UPDATE requests SET rank = ?, updated_at = ? WHERE id = ?").bind(i + 1, at, x as string)),
    change(db, { entity: "list", entity_id: gigId ?? `own:${email}`, op: "reorder", gig_id: gigId, email, actor: email,
      detail: { tier: t, n: ids.length } }),
  ]);
  return json(200, { mine: (await listRequests(db, email, gigId)).map(publicRequest) });
}

export async function deleteRequest(env: ListsEnv, email: string, id: string, request: Request): Promise<Response> {
  if (request.headers.get("X-Crates") !== "1") throw new HttpError(403, "Missing the X-Crates header.");
  const { row } = await ownRequest(env, email, id);
  const db = env.DB;
  const at = nowIso();
  await db.batch([
    db.prepare("UPDATE requests SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(at, at, id),
    change(db, { entity: "request", entity_id: id, op: "delete", gig_id: row.gig_id, email, actor: email,
      detail: { tier: row.tier, artist: row.artist, title: row.title } }),
  ]);
  return json(200, { deleted: id });
}

// A search that found nothing: folded, short, counted per day, never tied to a person.
export async function addMiss(env: ListsEnv, request: Request): Promise<Response> {
  const body = await readJson(request);
  const raw = typeof body.q === "string" ? body.q : "";
  const q = raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  if (q.length < 3) return json(200, { kept: false });
  const day = nowIso().slice(0, 10);
  const db = env.DB;
  const seen = await db.prepare("SELECT n FROM misses WHERE day = ? AND q = ?").bind(day, q).first<number>("n");
  if (seen === null) {
    const rows = (await db.prepare("SELECT COUNT(*) AS n FROM misses WHERE day = ?").bind(day).first<number>("n")) ?? 0;
    if (rows >= MAX_MISSES_PER_DAY) return json(200, { kept: false });
  }
  await db
    .prepare("INSERT INTO misses (day, q, n) VALUES (?, ?, 1) ON CONFLICT (day, q) DO UPDATE SET n = n + 1")
    .bind(day, q)
    .run();
  return json(200, { kept: true });
}

// Dispatch for /api/* (everything but /api/catalog and /api/admin). null = not ours.
export async function listsRoute(env: ListsEnv, request: Request, url: URL, email: string): Promise<Response | null> {
  const p = url.pathname;
  const m = request.method;
  if (p === "/api/me" && (m === "GET" || m === "HEAD")) return me(env, email);
  if (p === "/api/list" && m === "GET") return getList(env, email, url);
  if (p === "/api/requests" && m === "POST") return addRequest(env, email, request);
  if (p === "/api/requests/reorder" && m === "POST") return reorder(env, email, request);
  if (p === "/api/misses" && m === "POST") return addMiss(env, request);
  const one = /^\/api\/requests\/([0-9a-f-]{36})$/.exec(p);
  if (one && m === "PATCH") return patchRequest(env, email, one[1], request);
  if (one && m === "DELETE") return deleteRequest(env, email, one[1], request);
  return null;
}
