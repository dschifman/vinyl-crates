import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.ts";
import { resetKeyCache } from "../src/access.ts";
import { AUD_SITE, AUD_ADMIN, OWNER, PUBLISHER, makeTeam, sign, certsFetcher, env, caller } from "./helpers.mjs";

const team = await makeTeam();
beforeEach(() => {
  resetKeyCache();
  globalThis.fetch = certsFetcher(team);
});
const as = (e, email) => caller(worker, e, sign(team, { aud: [AUD_SITE], email }));
const mini = (e) => caller(worker, e, sign(team, { aud: [AUD_ADMIN], common_name: PUBLISHER, sub: "" }));
const song = (n) => ({ song_key: `artist ${n}|song ${n}`, artist: `Artist ${n}`, title: `Song ${n}` });
const day = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

test("gigs: validated on the way in", async () => {
  const dj = as(env(), OWNER);
  assert.equal((await dj("POST", "/api/dj/gigs", { date: "2026-11-14" })).status, 400, "a gig needs a name");
  assert.equal((await dj("POST", "/api/dj/gigs", { name: "X", date: "14/11/2026" })).status, 400);
  assert.equal((await dj("POST", "/api/dj/gigs", { name: "X", must_cap: 0 })).status, 400);
  assert.equal((await dj("POST", "/api/dj/gigs", { name: "X", requests_close_at: "someday" })).status, 400);
  const g = await dj("POST", "/api/dj/gigs", { name: " Sarah   & Tom ", date: "2026-11-14", venue: "The Barn" });
  assert.equal(g.status, 201);
  assert.deepEqual([g.body.gig.name, g.body.gig.must_cap, g.body.gig.status], ["Sarah & Tom", 20, "planning"]);
  assert.equal((await dj("PATCH", `/api/dj/gigs/${g.body.gig.id}`, { status: "maybe" })).status, 400);
});

test("adding a member invites them and turns their own list into the gig's", async () => {
  const e = env();
  const dj = as(e, OWNER);
  const client = as(e, "sarah@example.com");
  await client("POST", "/api/requests", song(1));
  await client("POST", "/api/requests", { ...song(2), tier: "must" });
  const gig = (await dj("POST", "/api/dj/gigs", { name: "Sarah & Tom", date: day(40) })).body.gig;
  const added = await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email: " Sarah@Example.com ", name: "Sarah", role: "host" });
  assert.equal(added.status, 201);
  assert.equal(added.body.moved, 2);
  assert.equal((await client("GET", "/api/list")).body.mine.length, 0, "the list moved");
  assert.equal((await client("GET", `/api/list?gig=${gig.id}`)).body.mine.length, 2);
  const invite = e.DB.rows("SELECT action, state, gig_id FROM invites WHERE email = 'sarah@example.com'")[0];
  assert.deepEqual(invite, { action: "add", state: "pending", gig_id: gig.id });
  assert.equal((await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email: "x@example.com", role: "boss" })).status, 400);
  assert.equal((await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email: "not-an-email", role: "host" })).status, 400);

  // A second booking does not steal a list that already belongs to the first.
  await client("POST", "/api/requests", song(3));
  const second = (await dj("POST", "/api/dj/gigs", { name: "Anniversary" })).body.gig;
  await client("POST", "/api/requests", { gig: gig.id, ...song(4) });
  const again = await dj("POST", `/api/dj/gigs/${second.id}/members`, { email: "sarah@example.com", role: "host" });
  assert.equal(again.body.moved, 1, "the new own list moves; the first gig's list stays");
  assert.equal((await client("GET", `/api/list?gig=${gig.id}`)).body.mine.length, 3);
});

test("removing a member takes their requests off that gig", async () => {
  const e = env();
  const dj = as(e, OWNER);
  const gig = (await dj("POST", "/api/dj/gigs", { name: "G" })).body.gig;
  await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email: "p@example.com", role: "planner" });
  await as(e, "p@example.com")("POST", "/api/requests", { gig: gig.id, ...song(1) });
  assert.equal((await dj("DELETE", `/api/dj/gigs/${gig.id}/members/${encodeURIComponent("p@example.com")}`)).status, 200);
  assert.equal((await dj("GET", `/api/dj/gigs/${gig.id}/merged`)).body.songs.length, 0);
  assert.equal((await as(e, "p@example.com")("GET", `/api/list?gig=${gig.id}`)).status, 404);
});

test("the merged list downloads as CSV a spreadsheet won't run", async () => {
  const e = env();
  const dj = as(e, OWNER);
  const gig = (await dj("POST", "/api/dj/gigs", { name: "Sarah & Tom", date: "2026-11-14", venue: "The Barn" })).body.gig;
  await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email: "h@example.com", name: "Sarah", role: "host" });
  const h = as(e, "h@example.com");
  await h("POST", "/api/requests", { gig: gig.id, tier: "must", song_key: "a|=cmd", artist: "=HYPERLINK(\"x\")", title: "Hello, \"world\"", note: "+1 for Mom" });
  await h("POST", "/api/requests", { gig: gig.id, tier: "dnp", ...song(2) });
  await h("POST", "/api/requests", { gig: gig.id, tier: "wish", artist: "Earth, Wind & Fire", title: "September" });
  const res = await dj("GET", `/api/dj/gigs/${gig.id}/merged.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /text\/csv/);
  assert.match(res.headers.get("Content-Disposition"), /attachment; filename="2026-11-14-Sarah-Tom\.csv"/);
  assert.ok(res.headers.get("Content-Security-Policy"), "the security headers ride along");
  const lines = res.body.trim().split("\r\n");
  assert.equal(lines[0], "Sarah & Tom -- 2026-11-14 -- The Barn");
  assert.equal(lines[1], "Section,Rank,Artist,Title,Score,Flagged,Moments,Notes,Who");
  assert.ok(lines[2].startsWith(`Play,1,"'=HYPERLINK(""x"")","Hello, ""world""",4.00`), lines[2]);
  assert.ok(lines[2].includes("Sarah: +1 for Mom"), "a note is text, not a formula, inside its cell");
  assert.ok(lines.some((l) => l.startsWith("Please don't play,,Artist 2,Song 2")));
  assert.ok(lines.some((l) => l.startsWith('Wish (not in the crates),,"Earth, Wind & Fire",September')));
});

test("the overview has gigs with members and counts, people's own lists, and misses", async () => {
  const e = env();
  const dj = as(e, OWNER);
  const gig = (await dj("POST", "/api/dj/gigs", { name: "G", date: day(10) })).body.gig;
  await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email: "h@example.com", role: "host" });
  await as(e, "h@example.com")("POST", "/api/requests", { gig: gig.id, tier: "must", ...song(1) });
  await as(e, "prospect@example.com")("POST", "/api/requests", song(2));
  await as(e, "prospect@example.com")("POST", "/api/misses", { q: "never heard of it" });
  const o = (await dj("GET", "/api/dj/overview")).body;
  assert.deepEqual(o.gigs.map((g) => [g.name, g.members.map((m) => [m.email, m.invite.state]), g.counts]),
    [["G", [["h@example.com", "pending"]], { must: 1 }]]);
  assert.deepEqual(o.prospects.map((p) => [p.email, p.n]), [["prospect@example.com", 1]]);
  assert.deepEqual(o.misses.map((m) => [m.q, m.n]), [["never heard of it", 1]]);
  const theirs = (await dj("GET", "/api/dj/list?email=prospect@example.com")).body;
  assert.deepEqual(theirs.mine.map((r) => r.title), ["Song 2"]);
});

test("invites: the Living Room mini applies them and says how it went", async () => {
  const e = env();
  const dj = as(e, OWNER);
  const lr = mini(e);
  await dj("POST", "/api/dj/invites", { email: "new@example.com" });
  assert.equal((await dj("POST", "/api/dj/access/remove", { email: OWNER })).status, 400, "never yourself");
  let pending = (await lr("GET", "/api/admin/invites")).body.invites;
  assert.deepEqual(pending.map((i) => [i.email, i.action]), [["new@example.com", "add"]]);
  // an answer for the wrong action changes nothing
  assert.equal((await lr("POST", "/api/admin/invites", { email: "new@example.com", action: "remove", state: "applied" })).body.updated, 0);
  assert.equal((await lr("POST", "/api/admin/invites", { email: "new@example.com", action: "add", state: "applied" })).body.updated, 1);
  assert.equal((await lr("GET", "/api/admin/invites")).body.invites.length, 0);
  // inviting someone already in stays applied; removing them is pending again
  await dj("POST", "/api/dj/invites", { email: "new@example.com" });
  assert.equal(e.DB.rows("SELECT state FROM invites")[0].state, "applied");
  await dj("POST", "/api/dj/access/remove", { email: "new@example.com" });
  pending = (await lr("GET", "/api/admin/invites")).body.invites;
  assert.deepEqual(pending.map((i) => [i.email, i.action]), [["new@example.com", "remove"]]);
  await lr("POST", "/api/admin/invites", { email: "new@example.com", action: "remove", state: "failed", error: "Cloudflare said no" });
  assert.deepEqual(e.DB.rows("SELECT state, error FROM invites")[0], { state: "failed", error: "Cloudflare said no" });
});

test("the change feed: a cursor, names joined in, the DJ's own changes marked", async () => {
  const e = env();
  const dj = as(e, OWNER);
  const lr = mini(e);
  const gig = (await dj("POST", "/api/dj/gigs", { name: "Sarah & Tom" })).body.gig;
  await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email: "h@example.com", name: "Sarah", role: "host" });
  await as(e, "h@example.com")("POST", "/api/requests", { gig: gig.id, tier: "must", ...song(1) });
  const all = (await lr("GET", "/api/admin/changes?since=0")).body;
  assert.deepEqual(all.changes.map((c) => [c.entity, c.op, c.by_owner]),
    [["gig", "add", true], ["member", "add", true], ["request", "add", false]]);
  const req = all.changes[2];
  assert.deepEqual([req.gig_name, req.member_name, req.detail.tier, req.detail.title], ["Sarah & Tom", "Sarah", "must", "Song 1"]);
  const page = (await lr("GET", "/api/admin/changes?since=0&limit=2")).body;
  assert.equal(page.changes.length, 2);
  assert.equal(page.more, true);
  const rest = (await lr("GET", `/api/admin/changes?since=${page.last}`)).body;
  assert.deepEqual([rest.changes.length, rest.more], [1, false]);
});

test("purge: a gig and its people go 12 months after its date; newer ones stay", async () => {
  const e = env();
  const dj = as(e, OWNER);
  const old = (await dj("POST", "/api/dj/gigs", { name: "Old", date: day(-400) })).body.gig;
  const recent = (await dj("POST", "/api/dj/gigs", { name: "Recent", date: day(-30) })).body.gig;
  for (const g of [old, recent]) {
    await dj("POST", `/api/dj/gigs/${g.id}/members`, { email: `h-${g.name}@example.com`, role: "host" });
    await as(e, `h-${g.name}@example.com`)("POST", "/api/requests", { gig: g.id, ...song(1) });
  }
  e.DB.db.prepare("INSERT INTO misses (day, q, n) VALUES (?, 'ancient', 1)").run(day(-500));
  const out = (await mini(e)("POST", "/api/admin/purge")).body;
  assert.deepEqual([out.gigs, out.requests, out.members, out.misses], [1, 1, 1, 1]);
  assert.deepEqual(e.DB.rows("SELECT name FROM gigs").map((g) => g.name), ["Recent"]);
  assert.equal(e.DB.rows("SELECT COUNT(*) AS n FROM changes WHERE gig_id = ?", old.id)[0].n, 0);
  assert.equal(e.DB.rows("SELECT COUNT(*) AS n FROM requests WHERE gig_id = ?", recent.id)[0].n, 1);
});
