// feed.ts -- what the Living Room mini pulls, with the dj-catalog-publisher token
// (the /api/admin Access application). Nothing here calls home: .249 asks.
//
//   GET  /api/admin/invites              invites and removals waiting to be applied
//   POST /api/admin/invites              how applying one went
//   GET  /api/admin/changes?since=<seq>  list changes after a cursor (pushes now, the ledger in Phase 4)
//   POST /api/admin/purge                drop gigs 12 months after their date (decision 8)

import { HttpError, json } from "./http.ts";
import { cleanEmail, isOwner, nowIso, optText, type ListsEnv } from "./lists.ts";

export const PURGE_AFTER_DAYS = 365;
export const KEEP_FEED_DAYS = 400;

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send JSON.");
  }
  try {
    const b = await request.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("not an object");
    return b as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "That isn't valid JSON.");
  }
}

async function pendingInvites(env: ListsEnv): Promise<Response> {
  const { results } = await env.DB
    .prepare("SELECT email, action, gig_id, created_at, updated_at FROM invites WHERE state = 'pending' ORDER BY updated_at")
    .all();
  return json(200, { invites: results });
}

async function inviteResult(env: ListsEnv, request: Request): Promise<Response> {
  const b = await body(request);
  const email = cleanEmail(b.email);
  const action = b.action;
  const state = b.state;
  if (action !== "add" && action !== "remove") throw new HttpError(400, "action is add or remove.");
  if (state !== "applied" && state !== "failed") throw new HttpError(400, "state is applied or failed.");
  const error = state === "failed" ? optText(b.error, 300, "error") ?? "failed" : null;
  // Only the request it answers: a newer invite or removal for the same person stays pending.
  const r = await env.DB
    .prepare("UPDATE invites SET state = ?, error = ?, updated_at = ? WHERE email = ? AND action = ? AND state = 'pending'")
    .bind(state, error, nowIso(), email, action)
    .run();
  return json(200, { updated: r.meta.changes ?? 0 });
}

async function changes(env: ListsEnv, url: URL): Promise<Response> {
  const since = Math.max(0, Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0);
  const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "500", 10) || 500));
  const { results } = await env.DB
    .prepare(
      `SELECT c.seq, c.entity, c.entity_id, c.op, c.gig_id, c.email, c.actor, c.detail, c.at,
              g.name AS gig_name, g.date AS gig_date, m.name AS member_name, m.role AS member_role
       FROM changes c
       LEFT JOIN gigs g ON g.id = c.gig_id
       LEFT JOIN members m ON m.gig_id = c.gig_id AND m.email = c.email
       WHERE c.seq > ? ORDER BY c.seq LIMIT ?`,
    )
    .bind(since, limit)
    .all<Record<string, unknown> & { seq: number; actor: string | null; detail: string | null }>();
  const out = results.map((c) => {
    let detail: unknown = null;
    try {
      detail = c.detail ? JSON.parse(c.detail) : null;
    } catch {
      detail = null;
    }
    return { ...c, detail, by_owner: Boolean(c.actor && isOwner(env, c.actor)) };
  });
  const last = out.length ? out[out.length - 1].seq : since;
  const head = (await env.DB.prepare("SELECT MAX(seq) AS s FROM changes").first<number | null>("s")) ?? 0;
  return json(200, { changes: out, last, more: last < head });
}

async function purge(env: ListsEnv): Promise<Response> {
  const db = env.DB;
  const gigCutoff = new Date(Date.now() - PURGE_AFTER_DAYS * 86400_000).toISOString().slice(0, 10);
  const feedCutoff = new Date(Date.now() - KEEP_FEED_DAYS * 86400_000).toISOString();
  const { results } = await db.prepare("SELECT id FROM gigs WHERE date IS NOT NULL AND date < ?").bind(gigCutoff).all<{ id: string }>();
  let requests = 0, members = 0;
  for (const { id } of results) {
    const [r, m] = await db.batch([
      db.prepare("DELETE FROM requests WHERE gig_id = ?").bind(id),
      db.prepare("DELETE FROM members WHERE gig_id = ?").bind(id),
      db.prepare("DELETE FROM changes WHERE gig_id = ?").bind(id),
      db.prepare("UPDATE invites SET gig_id = NULL WHERE gig_id = ?").bind(id),
      db.prepare("DELETE FROM gigs WHERE id = ?").bind(id),
    ]);
    requests += r.meta.changes ?? 0;
    members += m.meta.changes ?? 0;
  }
  const [c, mi] = await db.batch([
    db.prepare("DELETE FROM changes WHERE at < ?").bind(feedCutoff),
    db.prepare("DELETE FROM misses WHERE day < ?").bind(feedCutoff.slice(0, 10)),
  ]);
  return json(200, {
    gigs: results.length, requests, members, changes: c.meta.changes ?? 0, misses: mi.meta.changes ?? 0,
  });
}

export async function feedRoute(env: ListsEnv, request: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  const m = request.method;
  if (p === "/api/admin/invites" && m === "GET") return pendingInvites(env);
  if (p === "/api/admin/invites" && m === "POST") return inviteResult(env, request);
  if (p === "/api/admin/changes" && m === "GET") return changes(env, url);
  if (p === "/api/admin/purge" && m === "POST") return purge(env);
  return null;
}
