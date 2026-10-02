import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.ts";
import { resetKeyCache } from "../src/access.ts";
import { DEFAULT_MUST_CAP } from "../src/lists.ts";
import { AUD_SITE, OWNER, makeTeam, sign, certsFetcher, env, caller } from "./helpers.mjs";

const team = await makeTeam();
beforeEach(() => {
  resetKeyCache();
  globalThis.fetch = certsFetcher(team);
});
const as = (e, email) => caller(worker, e, sign(team, { aud: [AUD_SITE], email }));
const song = (n) => ({ song_key: `artist ${n}|song ${n}`, artist: `Artist ${n}`, title: `Song ${n}` });
const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString();
const PAST = new Date(Date.now() - 86400_000).toISOString();

async function gigWith(e, members, extra = {}) {
  const dj = as(e, OWNER);
  const gig = (await dj("POST", "/api/dj/gigs", { name: "Party", date: "2026-12-31", requests_close_at: FUTURE, ...extra })).body.gig;
  for (const [email, role] of members) await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email, role });
  return gig;
}

test("a prospect's own list: add, no duplicates, a version can be chosen later", async () => {
  const e = env();
  const me = as(e, "prospect@example.com");
  const first = await me("POST", "/api/requests", song(1));
  assert.equal(first.status, 201);
  assert.equal(first.body.request.tier, "want", "the plus button adds to Would love");
  assert.equal(first.body.request.rank, 1);
  assert.equal(first.body.request.email, undefined, "a request never echoes an email");
  const again = await me("POST", "/api/requests", { ...song(1), version_key: "123:A1", mix: "Club Mix" });
  assert.equal(again.status, 200);
  assert.equal(again.body.existed, true);
  assert.equal(again.body.request.version_key, "123:A1");
  const list = (await me("GET", "/api/list")).body;
  assert.equal(list.mine.length, 1);
  assert.equal(list.list.open, true);
  const lists = (await me("GET", "/api/me")).body.lists;
  assert.deepEqual(lists.map((l) => [l.gig, l.counts.want]), [[null, 1]]);
});

test("must play is capped, adding or moving", async () => {
  const e = env();
  const me = as(e, "cap@example.com");
  for (let n = 1; n <= DEFAULT_MUST_CAP; n++) {
    assert.equal((await me("POST", "/api/requests", { ...song(n), tier: "must" })).status, 201);
  }
  const over = await me("POST", "/api/requests", { ...song(99), tier: "must" });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /full/);
  const extra = (await me("POST", "/api/requests", song(100))).body.request;
  assert.equal((await me("PATCH", `/api/requests/${extra.id}`, { tier: "must" })).status, 409);
  // a gig's cap is the gig's
  const gig = await gigWith(e, [["small@example.com", "host"]], { must_cap: 2 });
  const small = as(e, "small@example.com");
  await small("POST", "/api/requests", { gig: gig.id, tier: "must", ...song(1) });
  await small("POST", "/api/requests", { gig: gig.id, tier: "must", ...song(2) });
  assert.equal((await small("POST", "/api/requests", { gig: gig.id, tier: "must", ...song(3) })).status, 409);
});

test("moving between tiers goes to the bottom; reordering needs the whole tier", async () => {
  const e = env();
  const me = as(e, "order@example.com");
  const ids = [];
  for (const n of [1, 2, 3]) ids.push((await me("POST", "/api/requests", song(n))).body.request.id);
  const moved = await me("PATCH", `/api/requests/${ids[0]}`, { tier: "must", moment: "First dance", note: "for Mom\nand Dad" });
  assert.equal(moved.status, 200);
  assert.deepEqual([moved.body.request.tier, moved.body.request.rank, moved.body.request.moment, moved.body.request.note],
    ["must", 1, "First dance", "for Mom\nand Dad"]);
  assert.equal((await me("POST", "/api/requests/reorder", { tier: "want", ids: [ids[2]] })).status, 409, "a partial tier is refused");
  const re = await me("POST", "/api/requests/reorder", { tier: "want", ids: [ids[2], ids[1]] });
  assert.equal(re.status, 200);
  assert.deepEqual(re.body.mine.filter((r) => r.tier === "want").map((r) => r.title), ["Song 3", "Song 2"]);
});

test("wishes are free text and stay wishes; delete is soft and logged", async () => {
  const e = env();
  const me = as(e, "wish@example.com");
  assert.equal((await me("POST", "/api/requests", { tier: "wish", artist: "" })).status, 400, "a wish needs a title");
  const w = (await me("POST", "/api/requests", { tier: "wish", artist: "Earth, Wind & Fire", title: "September" })).body.request;
  assert.equal(w.song_key, null);
  assert.equal((await me("PATCH", `/api/requests/${w.id}`, { tier: "must" })).status, 400);
  const s = (await me("POST", "/api/requests", song(1))).body.request;
  assert.equal((await me("DELETE", `/api/requests/${s.id}`)).status, 200);
  assert.equal((await me("GET", "/api/list")).body.mine.length, 1);
  const row = e.DB.rows("SELECT deleted_at FROM requests WHERE id = ?", s.id)[0];
  assert.ok(row.deleted_at, "kept, marked deleted, so the feed can carry it");
  const ops = e.DB.rows("SELECT op FROM changes WHERE email = ? ORDER BY seq", "wish@example.com").map((r) => r.op);
  assert.deepEqual(ops, ["add", "add", "delete"]);
});

test("bad input is refused with a reason", async () => {
  const e = env();
  const me = as(e, "picky@example.com");
  assert.equal((await me("POST", "/api/requests", { ...song(1), moment: "Breakdance battle" })).status, 400);
  assert.equal((await me("POST", "/api/requests", { ...song(1), note: "x".repeat(501) })).status, 400);
  assert.equal((await me("POST", "/api/requests", { ...song(1), tier: "maybe" })).status, 400);
  assert.equal((await me("POST", "/api/requests", { ...song(1), version_key: "not a version" })).status, 400);
  assert.equal((await me("POST", "/api/requests", { song_key: "a|b", title: "B" })).status, 400, "the artist is required");
  // the CSRF guard: no X-Crates header, or not JSON
  const token = await sign(team, { aud: [AUD_SITE], email: "picky@example.com" });
  const raw = (headers, body) => worker.fetch(new Request("https://crates.bobshrimp.com/api/requests", {
    method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, ...headers }, body,
  }), e);
  assert.equal((await raw({ "Content-Type": "application/json" }, JSON.stringify(song(1)))).status, 403);
  assert.equal((await raw({ "X-Crates": "1", "Content-Type": "text/plain" }, JSON.stringify(song(1)))).status, 415);
  assert.equal((await raw({ "X-Crates": "1", "Content-Type": "application/json" }, "{nope")).status, 400);
  assert.equal(e.DB.rows("SELECT COUNT(*) AS n FROM requests")[0].n, 0);
});

test("nobody edits another person's request", async () => {
  const e = env();
  const mine = (await as(e, "a@example.com")("POST", "/api/requests", song(1))).body.request;
  const thief = as(e, "b@example.com");
  assert.equal((await thief("PATCH", `/api/requests/${mine.id}`, { tier: "must" })).status, 404);
  assert.equal((await thief("DELETE", `/api/requests/${mine.id}`)).status, 404);
  assert.equal((await thief("GET", "/api/list")).body.mine.length, 0);
});

test("a gig's list: members see each other's, outsiders see nothing", async () => {
  const e = env();
  const gig = await gigWith(e, [["host@example.com", "host"], ["planner@example.com", "planner"]]);
  const host = as(e, "host@example.com");
  await host("POST", "/api/requests", { gig: gig.id, ...song(1) });
  const seen = (await as(e, "planner@example.com")("GET", `/api/list?gig=${gig.id}`)).body;
  assert.equal(seen.list.role, "planner");
  assert.deepEqual(seen.others.map((o) => [o.email, o.requests.length]), [["host@example.com", 1]]);
  const outsider = as(e, "outsider@example.com");
  assert.equal((await outsider("GET", `/api/list?gig=${gig.id}`)).status, 404);
  assert.equal((await outsider("POST", "/api/requests", { gig: gig.id, ...song(2) })).status, 404);
  const lists = (await host("GET", "/api/me")).body.lists;
  assert.deepEqual(lists.map((l) => l.gig?.name ?? "own"), ["Party", "own"]);
});

test("after the close date, or once locked, a list is read-only", async () => {
  const e = env();
  const closed = await gigWith(e, [["late@example.com", "host"]], { requests_close_at: PAST });
  const late = as(e, "late@example.com");
  assert.equal((await late("GET", `/api/list?gig=${closed.id}`)).body.list.open, false);
  assert.equal((await late("POST", "/api/requests", { gig: closed.id, ...song(1) })).status, 409);
  const open = await gigWith(e, [["early@example.com", "host"]]);
  const early = as(e, "early@example.com");
  const r = (await early("POST", "/api/requests", { gig: open.id, ...song(1) })).body.request;
  await as(e, OWNER)("PATCH", `/api/dj/gigs/${open.id}`, { status: "locked" });
  assert.equal((await early("PATCH", `/api/requests/${r.id}`, { tier: "must" })).status, 409);
  assert.equal((await early("DELETE", `/api/requests/${r.id}`)).status, 409);
  await as(e, OWNER)("PATCH", `/api/dj/gigs/${open.id}`, { status: "planning" });
  assert.equal((await early("PATCH", `/api/requests/${r.id}`, { tier: "must" })).status, 200, "reopened by the DJ");
});

test("searches that found nothing are counted per day, with no identity", async () => {
  const e = env();
  const me = as(e, "searcher@example.com");
  assert.equal((await me("POST", "/api/misses", { q: "ab" })).body.kept, false);
  await me("POST", "/api/misses", { q: "  Earth   Wind " });
  await as(e, "other@example.com")("POST", "/api/misses", { q: "earth wind" });
  const rows = e.DB.rows("SELECT * FROM misses");
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["day", "n", "q"], "nothing about who searched");
  assert.equal(rows[0].n, 2);
});
