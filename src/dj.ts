// dj.ts -- the DJ's side, for OWNER_EMAIL only (Phase 3 "your web view"):
//
//   GET    /api/dj/overview                         gigs, people's own lists, invites, missed searches
//   POST   /api/dj/gigs                             a new gig
//   PATCH  /api/dj/gigs/<id>                        edit it, lock it, mark it played
//   POST   /api/dj/gigs/<id>/members                add a host or planner (and invite them)
//   DELETE /api/dj/gigs/<id>/members/<email>        take someone off a gig
//   GET    /api/dj/gigs/<id>/merged                 everyone's lists merged (section 5.3)
//   GET    /api/dj/gigs/<id>/merged.csv             the same, for a spreadsheet or the printer
//   GET    /api/dj/list?email=<e>&gig=<id>          one person's list as they see it
//   POST   /api/dj/invites                          let someone sign in (no gig yet)
//   POST   /api/dj/access/remove                    take someone out of the Access group
//
// Invites are rows here; the Living Room mini applies them to the Access group "DJ
// clients" through the Cloudflare API (feed.ts) -- the token that can edit Access
// stays in its secrets.json and never sits in this Worker.

import { HttpError, json, readJson, secure } from "./http.ts";
import { mergeGig, type MergeMember, type MergeRequest, type Merged, type Role } from "./merge.ts";
import {
  ROLES, STATUSES, DEFAULT_MUST_CAP, change, cleanEmail, listOpen, listRequests, loadGig, newId, nowIso,
  optText, publicRequest, reqText, type Gig, type ListsEnv,
} from "./lists.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function date(v: unknown): string | null {
  const t = optText(v, 10, "The date");
  if (t && (!DATE_RE.test(t) || Number.isNaN(Date.parse(`${t}T12:00:00Z`)))) throw new HttpError(400, "Dates look like 2026-11-14.");
  return t;
}

function instant(v: unknown): string | null {
  const t = optText(v, 40, "The close time");
  if (!t) return null;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new HttpError(400, "That close time isn't a date and time.");
  return new Date(ms).toISOString();
}

function cap(v: unknown): number {
  if (v === undefined || v === null || v === "") return DEFAULT_MUST_CAP;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new HttpError(400, "The must-play cap is a whole number from 1 to 200.");
  return n;
}

async function inviteState(db: D1Database, emails: string[]): Promise<Map<string, { action: string; state: string; error: string | null }>> {
  const out = new Map();
  if (!emails.length) return out;
  const { results } = await db
    .prepare(`SELECT email, action, state, error FROM invites WHERE email IN (${emails.map(() => "?").join(",")})`)
    .bind(...emails)
    .all<{ email: string; action: string; state: string; error: string | null }>();
  for (const r of results) out.set(r.email, { action: r.action, state: r.state, error: r.error });
  return out;
}

// Ask the Living Room mini to put someone in (or take them out of) the Access group.
function inviteStatement(db: D1Database, email: string, action: "add" | "remove", gigId: string | null, at: string) {
  return db
    .prepare(
      `INSERT INTO invites (email, action, state, gig_id, error, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, NULL, ?, ?)
       ON CONFLICT (email) DO UPDATE SET
         state = CASE WHEN invites.action = excluded.action AND invites.state = 'applied' THEN 'applied' ELSE 'pending' END,
         action = excluded.action, gig_id = COALESCE(excluded.gig_id, invites.gig_id), error = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(email, action, gigId, at, at);
}

async function overview(env: ListsEnv): Promise<Response> {
  const db = env.DB;
  const { results: gigs } = await db
    .prepare("SELECT * FROM gigs ORDER BY status = 'archived', date IS NULL, date DESC, created_at DESC")
    .all<Gig>();
  const { results: members } = await db
    .prepare("SELECT gig_id, email, name, role FROM members ORDER BY created_at")
    .all<{ gig_id: string; email: string; name: string | null; role: Role }>();
  const { results: tiers } = await db
    .prepare("SELECT gig_id, tier, COUNT(*) AS n FROM requests WHERE gig_id IS NOT NULL AND deleted_at IS NULL GROUP BY gig_id, tier")
    .all<{ gig_id: string; tier: string; n: number }>();
  const { results: prospects } = await db
    .prepare(
      `SELECT email, COUNT(*) AS n, MAX(updated_at) AS updated_at FROM requests
       WHERE gig_id IS NULL AND deleted_at IS NULL GROUP BY email ORDER BY MAX(updated_at) DESC`,
    )
    .all<{ email: string; n: number; updated_at: string }>();
  const { results: invites } = await db
    .prepare("SELECT email, action, state, gig_id, error, updated_at FROM invites ORDER BY updated_at DESC")
    .all();
  const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const { results: misses } = await db
    .prepare("SELECT q, SUM(n) AS n, MAX(day) AS last FROM misses WHERE day >= ? GROUP BY q ORDER BY SUM(n) DESC, MAX(day) DESC LIMIT 100")
    .bind(since)
    .all();
  const states = await inviteState(db, [...new Set([...members.map((m) => m.email), ...prospects.map((p) => p.email)])]);
  const now = nowIso();
  return json(200, {
    gigs: gigs.map((g) => ({
      ...g,
      open: listOpen(g, now),
      members: members.filter((m) => m.gig_id === g.id).map(({ gig_id: _g, ...m }) => ({ ...m, invite: states.get(m.email) ?? null })),
      counts: Object.fromEntries(tiers.filter((t) => t.gig_id === g.id).map((t) => [t.tier, t.n])),
    })),
    prospects: prospects.map((p) => ({ ...p, invite: states.get(p.email) ?? null })),
    invites,
    misses,
  });
}

async function createGig(env: ListsEnv, owner: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  const at = nowIso();
  const gig: Gig = {
    id: newId(), name: reqText(body.name, 120, "The gig's name"), date: date(body.date),
    venue: optText(body.venue, 160, "The venue"), status: "planning", requests_close_at: instant(body.requests_close_at),
    must_cap: cap(body.must_cap), created_at: at, updated_at: at,
  };
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO gigs (id, name, date, venue, status, requests_close_at, must_cap, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(gig.id, gig.name, gig.date, gig.venue, gig.status, gig.requests_close_at, gig.must_cap, at, at),
    change(db, { entity: "gig", entity_id: gig.id, op: "add", gig_id: gig.id, email: null, actor: owner, detail: { name: gig.name } }),
  ]);
  return json(201, { gig });
}

async function patchGig(env: ListsEnv, owner: string, id: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  const gig = await loadGig(env.DB, id);
  if (!gig) throw new HttpError(404, "No such gig.");
  const next = { ...gig };
  if (body.name !== undefined) next.name = reqText(body.name, 120, "The gig's name");
  if (body.date !== undefined) next.date = date(body.date);
  if (body.venue !== undefined) next.venue = optText(body.venue, 160, "The venue");
  if (body.requests_close_at !== undefined) next.requests_close_at = instant(body.requests_close_at);
  if (body.must_cap !== undefined) next.must_cap = cap(body.must_cap);
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUSES.includes(body.status)) throw new HttpError(400, "Unknown status.");
    next.status = body.status;
  }
  next.updated_at = nowIso();
  const db = env.DB;
  await db.batch([
    db.prepare(
      "UPDATE gigs SET name = ?, date = ?, venue = ?, status = ?, requests_close_at = ?, must_cap = ?, updated_at = ? WHERE id = ?",
    ).bind(next.name, next.date, next.venue, next.status, next.requests_close_at, next.must_cap, next.updated_at, id),
    change(db, { entity: "gig", entity_id: id, op: "update", gig_id: id, email: null, actor: owner,
      detail: { name: next.name, status: next.status } }),
  ]);
  return json(200, { gig: { ...next, open: listOpen(next) } });
}

async function addMember(env: ListsEnv, owner: string, gigId: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  const gig = await loadGig(env.DB, gigId);
  if (!gig) throw new HttpError(404, "No such gig.");
  const email = cleanEmail(body.email);
  const name = optText(body.name, 120, "The name");
  const role = (body.role ?? "host") as Role;
  if (!ROLES.includes(role)) throw new HttpError(400, "A member is a host, a planner or a guest.");
  const db = env.DB;
  const at = nowIso();
  // A list started before the booking becomes the gig's list (section 5.1), unless
  // they already have one for this gig -- then the two are left for you to look at.
  const already = (await db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE email = ? AND gig_id = ? AND deleted_at IS NULL")
    .bind(email, gigId)
    .first<number>("n")) ?? 0;
  const own = (await db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE email = ? AND gig_id IS NULL AND deleted_at IS NULL")
    .bind(email)
    .first<number>("n")) ?? 0;
  const move = already === 0 && own > 0;
  const stmts = [
    db.prepare(
      `INSERT INTO members (gig_id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (gig_id, email) DO UPDATE SET name = COALESCE(excluded.name, members.name), role = excluded.role`,
    ).bind(gigId, email, name, role, at),
    inviteStatement(db, email, "add", gigId, at),
    change(db, { entity: "member", entity_id: email, op: "add", gig_id: gigId, email, actor: owner, detail: { role, moved: move ? own : 0 } }),
  ];
  if (move) {
    stmts.push(db.prepare("UPDATE requests SET gig_id = ?, updated_at = ? WHERE email = ? AND gig_id IS NULL AND deleted_at IS NULL")
      .bind(gigId, at, email));
  }
  await db.batch(stmts);
  return json(201, { member: { email, name, role }, moved: move ? own : 0, kept_own_list: !move && own > 0 ? own : 0 });
}

async function removeMember(env: ListsEnv, owner: string, gigId: string, email: string): Promise<Response> {
  const db = env.DB;
  const row = await db.prepare("SELECT role FROM members WHERE gig_id = ? AND email = ?").bind(gigId, email).first();
  if (!row) throw new HttpError(404, "Not on this gig.");
  const at = nowIso();
  await db.batch([
    db.prepare("DELETE FROM members WHERE gig_id = ? AND email = ?").bind(gigId, email),
    db.prepare("UPDATE requests SET deleted_at = ?, updated_at = ? WHERE gig_id = ? AND email = ? AND deleted_at IS NULL")
      .bind(at, at, gigId, email),
    change(db, { entity: "member", entity_id: email, op: "delete", gig_id: gigId, email, actor: owner }),
  ]);
  return json(200, { removed: email });
}

async function mergedFor(env: ListsEnv, gigId: string): Promise<{ gig: Gig; members: MergeMember[]; merged: Merged }> {
  const gig = await loadGig(env.DB, gigId);
  if (!gig) throw new HttpError(404, "No such gig.");
  const { results: members } = await env.DB
    .prepare("SELECT email, name, role FROM members WHERE gig_id = ? ORDER BY role, created_at")
    .bind(gigId)
    .all<MergeMember>();
  const { results: rows } = await env.DB
    .prepare("SELECT * FROM requests WHERE gig_id = ? AND deleted_at IS NULL")
    .bind(gigId)
    .all<MergeRequest>();
  return { gig, members, merged: mergeGig(members, rows) };
}

// A cell a spreadsheet will not run as a formula.
function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(gig: Gig, merged: Merged): string {
  const who = (e: { name: string | null; email: string }) => e.name || e.email;
  const tierName: Record<string, string> = { must: "Must play", want: "Would love", dnp: "Please don't play", wish: "Wish" };
  const rows: unknown[][] = [["Section", "Rank", "Artist", "Title", "Score", "Flagged", "Moments", "Notes", "Who"]];
  merged.songs.forEach((s, i) => {
    rows.push([
      "Play", i + 1, s.artist, s.title, s.score.toFixed(2), s.flagged ? "planner said please don't" : "",
      [...new Set(s.entries.map((e) => e.moment).filter(Boolean))].join("; "),
      s.entries.filter((e) => e.note).map((e) => `${who(e)}: ${e.note}`).join(" | "),
      s.entries.map((e) => `${who(e)} (${tierName[e.tier]} #${e.rank} of ${e.of})`).join("; "),
    ]);
  });
  for (const s of merged.vetoed) {
    rows.push(["Vetoed by a host", "", s.artist, s.title, s.score.toFixed(2), "", "", "",
      s.entries.map((e) => `${who(e)} (${tierName[e.tier]} #${e.rank})`).join("; ")]);
  }
  for (const s of merged.dnp) {
    rows.push(["Please don't play", "", s.artist, s.title, "", "", "",
      s.entries.filter((e) => e.note).map((e) => `${who(e)}: ${e.note}`).join(" | "),
      s.entries.map((e) => `${who(e)} (${e.role})`).join("; ")]);
  }
  for (const w of merged.wishes) {
    rows.push(["Wish (not in the crates)", "", w.artist, w.title, "", "", "",
      w.entries.filter((e) => e.note).map((e) => `${who(e)}: ${e.note}`).join(" | "),
      w.entries.map((e) => who(e)).join("; ")]);
  }
  const head = `${gig.name}${gig.date ? ` -- ${gig.date}` : ""}${gig.venue ? ` -- ${gig.venue}` : ""}`;
  return [cell(head), ...rows.map((r) => r.map(cell).join(","))].join("\r\n") + "\r\n";
}

async function personList(env: ListsEnv, url: URL): Promise<Response> {
  const email = cleanEmail(url.searchParams.get("email"));
  const gigId = url.searchParams.get("gig") || null;
  const gig = gigId ? await loadGig(env.DB, gigId) : null;
  if (gigId && !gig) throw new HttpError(404, "No such gig.");
  return json(200, { email, gig, mine: (await listRequests(env.DB, email, gigId)).map(publicRequest) });
}

async function invite(env: ListsEnv, owner: string, request: Request, action: "add" | "remove"): Promise<Response> {
  const body = await readJson(request);
  const email = cleanEmail(body.email);
  if (action === "remove" && email === owner) throw new HttpError(400, "That's you.");
  const db = env.DB;
  const at = nowIso();
  await db.batch([
    inviteStatement(db, email, action, null, at),
    change(db, { entity: "invite", entity_id: email, op: action, gig_id: null, email, actor: owner }),
  ]);
  return json(200, { email, action, state: "pending" });
}

export async function djRoute(env: ListsEnv, request: Request, url: URL, owner: string): Promise<Response | null> {
  const p = url.pathname;
  const m = request.method;
  if (p === "/api/dj/overview" && m === "GET") return overview(env);
  if (p === "/api/dj/gigs" && m === "POST") return createGig(env, owner, request);
  if (p === "/api/dj/list" && m === "GET") return personList(env, url);
  if (p === "/api/dj/invites" && m === "POST") return invite(env, owner, request, "add");
  if (p === "/api/dj/access/remove" && m === "POST") return invite(env, owner, request, "remove");
  let g = /^\/api\/dj\/gigs\/([0-9a-f-]{36})$/.exec(p);
  if (g && m === "PATCH") return patchGig(env, owner, g[1], request);
  g = /^\/api\/dj\/gigs\/([0-9a-f-]{36})\/members$/.exec(p);
  if (g && m === "POST") return addMember(env, owner, g[1], request);
  g = /^\/api\/dj\/gigs\/([0-9a-f-]{36})\/members\/([^/]+)$/.exec(p);
  if (g && m === "DELETE") {
    if (request.headers.get("X-Crates") !== "1") throw new HttpError(403, "Missing the X-Crates header.");
    return removeMember(env, owner, g[1], cleanEmail(decodeURIComponent(g[2])));
  }
  g = /^\/api\/dj\/gigs\/([0-9a-f-]{36})\/merged(\.csv)?$/.exec(p);
  if (g && m === "GET") {
    const { gig, members, merged } = await mergedFor(env, g[1]);
    if (g[2]) {
      const file = `${(gig.date ?? "gig")}-${gig.name}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
      return new Response(csv(gig, merged), {
        status: 200,
        headers: secure({
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${file}.csv"`,
          "Cache-Control": "no-store",
        }),
      });
    }
    return json(200, { gig: { ...gig, open: listOpen(gig) }, members, ...merged });
  }
  return null;
}
