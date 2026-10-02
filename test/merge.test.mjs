import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.ts";
import { mergeGig } from "../src/merge.ts";
import { resetKeyCache } from "../src/access.ts";
import { AUD_SITE, OWNER, makeTeam, sign, certsFetcher, env, caller } from "./helpers.mjs";

const team = await makeTeam();
beforeEach(() => {
  resetKeyCache();
  globalThis.fetch = certsFetcher(team);
});
const as = (e, email) => caller(worker, e, sign(team, { aud: [AUD_SITE], email }));
const song = (n) => ({ song_key: `artist ${n}|song ${n}`, artist: `Artist ${n}`, title: `Song ${n}` });
const KISS = { song_key: "prince|kiss", artist: "Prince", title: "Kiss" };
const FUTURE = new Date(Date.now() + 30 * 86400_000).toISOString();

// Phase 3's "done when": a mock gig with three members produces the merged list
// in section 5.3 -- the bride has "Kiss" at Must #2 of 5 (3 + 0.8 = 3.8), the
// groom at Would love #1 of 10 (1 + 1.0 = 2.0), the planner doesn't list it:
// its score is 5.8.
test("a mock gig with three members produces the merged list in section 5.3", async () => {
  const e = env();
  const dj = as(e, OWNER);
  const gig = (await dj("POST", "/api/dj/gigs", { name: "Sarah & Tom", date: "2026-11-14", requests_close_at: FUTURE })).body.gig;
  for (const [email, name, role] of [["bride@example.com", "Sarah", "host"], ["groom@example.com", "Tom", "host"],
    ["planner@example.com", "Pat", "planner"]]) {
    assert.equal((await dj("POST", `/api/dj/gigs/${gig.id}/members`, { email, name, role })).status, 201);
  }

  const bride = as(e, "bride@example.com");
  for (const s of [song(1), KISS, song(2), song(3), song(4)]) {
    assert.equal((await bride("POST", "/api/requests", { gig: gig.id, tier: "must", ...s })).status, 201);
  }
  const groom = as(e, "groom@example.com");
  for (const s of [KISS, ...[5, 6, 7, 8, 9, 10, 11, 12, 13].map(song)]) {
    assert.equal((await groom("POST", "/api/requests", { gig: gig.id, ...s })).status, 201);   // Would love by default
  }
  const planner = as(e, "planner@example.com");
  for (const s of [song(1), song(14)]) await planner("POST", "/api/requests", { gig: gig.id, tier: "must", ...s });

  const merged = (await dj("GET", `/api/dj/gigs/${gig.id}/merged`)).body;
  const kiss = merged.songs.find((s) => s.song_key === KISS.song_key);
  assert.ok(Math.abs(kiss.score - 5.8) < 1e-9, `Kiss scores ${kiss.score}`);
  const parts = Object.fromEntries(kiss.entries.map((x) => [x.name, [x.tier, x.rank, x.of, Math.round(x.points * 100) / 100]]));
  assert.deepEqual(parts, { Sarah: ["must", 2, 5, 3.8], Tom: ["want", 1, 10, 2] });

  // Song 1: the bride's Must #1 of 5 (4.0) and the planner's Must #1 of 2 at 0.75 x 4 = 3.0
  const one = merged.songs.find((s) => s.song_key === song(1).song_key);
  assert.ok(Math.abs(one.score - 7) < 1e-9, `song 1 scores ${one.score}`);
  assert.deepEqual(merged.songs.slice(0, 2).map((s) => s.title), ["Song 1", "Kiss"]);
  const scores = merged.songs.map((s) => s.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "sorted by score");
});

const R = (o) => ({ id: o.id ?? `${o.email}-${o.song_key ?? o.title}-${o.tier}`, version_key: null, mix: null, moment: null, note: null,
  created_at: "2026-10-01T00:00:00.000Z", artist: "A", title: o.song_key ?? "t", ...o });
const members = [
  { email: "h@x", name: "Host", role: "host" },
  { email: "p@x", name: "Planner", role: "planner" },
];

test("a host's please-don't removes a song; a planner's only flags it", () => {
  const m = mergeGig(members, [
    R({ email: "p@x", song_key: "a", tier: "must", rank: 1 }),
    R({ email: "h@x", song_key: "a", tier: "dnp", rank: 1 }),
    R({ email: "h@x", song_key: "b", tier: "want", rank: 1 }),
    R({ email: "p@x", song_key: "b", tier: "dnp", rank: 1 }),
  ]);
  assert.deepEqual(m.songs.map((s) => [s.song_key, s.flagged]), [["b", true]]);
  assert.deepEqual(m.vetoed.map((s) => s.song_key), ["a"]);
  assert.deepEqual(m.dnp.map((s) => s.song_key).sort(), ["a", "b"]);
});

test("ties go to the earliest request; non-members and wishes don't score", () => {
  const m = mergeGig(members, [
    R({ email: "h@x", song_key: "late", tier: "want", rank: 1, created_at: "2026-10-02T00:00:00.000Z" }),
    R({ email: "p@x", song_key: "early", tier: "want", rank: 1, created_at: "2026-10-01T00:00:00.000Z" }),
    R({ email: "gone@x", song_key: "ghost", tier: "must", rank: 1 }),
    R({ email: "h@x", song_key: null, title: "September", artist: "Earth, Wind & Fire", tier: "wish", rank: 1 }),
    R({ email: "p@x", song_key: null, title: "september ", artist: "EARTH WIND & FIRE", tier: "wish", rank: 1 }),
  ]);
  // host want #1 of 1 = 2.0; planner want #1 of 1 = 0.75 x 2 = 1.5
  assert.deepEqual(m.songs.map((s) => [s.song_key, s.score]), [["late", 2], ["early", 1.5]]);
  assert.ok(!m.songs.some((s) => s.song_key === "ghost"), "someone no longer on the gig doesn't count");
  assert.equal(m.wishes.length, 1, "the same wish from two people is one wish");
  assert.equal(m.wishes[0].entries.length, 2);
  const tie = mergeGig([members[0]], [
    R({ email: "h@x", song_key: "x", tier: "want", rank: 1, created_at: "2026-10-03T00:00:00.000Z" }),
  ]).songs;
  assert.equal(tie[0].first_at, "2026-10-03T00:00:00.000Z");
});

test("rank bonus runs from 1.0 at the top of a tier to 1/n at the bottom", () => {
  const m = mergeGig([members[0]], [1, 2, 3, 4].map((rank) => R({ email: "h@x", song_key: `s${rank}`, tier: "must", rank })));
  assert.deepEqual(m.songs.map((s) => s.score), [4, 3.75, 3.5, 3.25]);
});
