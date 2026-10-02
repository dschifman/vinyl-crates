import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { CURRENT_KEY, KEEP_SNAPSHOTS, SECURITY_HEADERS, VERSION } from "../src/worker.ts";
import { resetKeyCache } from "../src/access.ts";
import { AUD_SITE, AUD_ADMIN, PUBLISHER, makeTeam, sign, certsFetcher, env, gzipJson, sha256Hex } from "./helpers.mjs";

const team = await makeTeam();
beforeEach(() => {
  resetKeyCache();
  globalThis.fetch = certsFetcher(team);
});

const visitor = () => sign(team, { aud: [AUD_SITE], email: "client@example.com" });
const publisher = () => sign(team, { aud: [AUD_ADMIN], common_name: PUBLISHER, sub: "" });

async function call(e, path, { token, method = "GET", headers = {}, body } = {}) {
  const h = new Headers(headers);
  if (token) h.set("Cf-Access-Jwt-Assertion", token);
  return worker.fetch(new Request(`https://crates.bobshrimp.com${path}`, { method, headers: h, body }), e);
}

function snapshot(n = 1) {
  return {
    schema: 1, buckets: ["Pop"], occasions: [], releases: {},
    songs: [{ k: `a|song ${n}`, a: "A", t: `Song ${n}`, y: 1980, b: ["Pop"], v: [] }],
    hash: `sha256:${String(n).padStart(64, "0")}`, built_at: "2026-10-01T00:00:00Z",
    counts: { songs: 1, releases: 0 },
  };
}

async function publish(e, snap, { token, tamper = false } = {}) {
  const gz = await gzipJson(snap);
  const sha = await sha256Hex(gz);
  if (tamper) gz[gz.length - 1] ^= 0xff;
  return call(e, "/api/admin/catalog", {
    token: token ?? (await publisher()),
    method: "PUT",
    headers: {
      "Content-Type": "application/gzip",
      "X-Catalog-Hash": snap.hash,
      "X-Body-Sha256": sha,
      "X-Catalog-Built-At": snap.built_at,
      "X-Catalog-Counts": JSON.stringify(snap.counts),
    },
    body: gz,
  });
}

async function gunzipJson(res) {
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

test("nothing is served until Access is configured", async () => {
  for (const missing of ["TEAM_DOMAIN", "ACCESS_AUD_SITE", "ACCESS_AUD_ADMIN", "PUBLISHER_CLIENT_ID"]) {
    const res = await call(env({ [missing]: "" }), "/", { token: await visitor() });
    assert.equal(res.status, 503, missing);
  }
});

test("no token, or a bad one, gets nothing -- page, assets or API", async () => {
  const e = env();
  for (const path of ["/", "/app.js", "/api/catalog", "/api/me", "/api/admin/status"]) {
    assert.equal((await call(e, path)).status, 403, path);
    assert.equal((await call(e, path, { token: "x.y.z" })).status, 403, path);
  }
});

test("a visitor gets the page with security headers, and who they are", async () => {
  const e = env();
  const page = await call(e, "/", { token: await visitor() });
  assert.equal(page.status, 200);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(page.headers.get(k), v, k);
  assert.equal(page.headers.get("Cache-Control"), "no-cache");
  assert.equal(page.headers.get("ETag"), '"page"');
  const me = await (await call(e, "/api/me", { token: await visitor() })).json();
  assert.equal(me.email, "client@example.com");
  assert.equal(me.version, VERSION);
  assert.equal(me.owner, false);
  assert.equal(page.headers.get("X-Crates-Version"), VERSION);
  assert.equal((await call(e, "/api/nope", { token: await visitor() })).status, 404);
  assert.equal((await call(e, "/api/catalog", { token: await visitor(), method: "POST" })).status, 405);
});

test("the DJ's page and API are the owner's alone", async () => {
  const e = env();
  const owner = await sign(team, { aud: [AUD_SITE], email: "DJ@Example.com" });   // case doesn't matter
  for (const path of ["/dj", "/dj/", "/dj.html", "/dj.js", "/dj.css"]) {
    assert.equal((await call(e, path, { token: await visitor() })).status, 404, path);
    assert.equal((await call(e, path, { token: owner })).status, 200, path);
  }
  assert.equal((await call(e, "/api/dj/overview", { token: await visitor() })).status, 403);
  assert.equal((await call(e, "/api/dj/overview", { token: owner })).status, 200);
  assert.equal((await (await call(e, "/api/me", { token: owner })).json()).owner, true);
  // no owner configured: nobody is the owner
  assert.equal((await call(env({ OWNER_EMAIL: "" }), "/api/dj/overview", { token: owner })).status, 403);
});

test("the Living Room mini's feed takes the publisher's token only", async () => {
  const e = env();
  assert.equal((await call(e, "/api/admin/invites", { token: await publisher() })).status, 200);
  assert.equal((await call(e, "/api/admin/changes", { token: await publisher() })).status, 200);
  assert.equal((await call(e, "/api/admin/invites", { token: await visitor() })).status, 403);
  const stranger = await sign(team, { aud: [AUD_ADMIN], common_name: "someone-else.access" });
  assert.equal((await call(e, "/api/admin/purge", { token: stranger, method: "POST" })).status, 403);
});

test("before the first publish the catalog says so", async () => {
  const res = await call(env(), "/api/catalog", { token: await visitor() });
  assert.equal(res.status, 503);
});

test("the publisher publishes; visitors get it, then a 304 while it is unchanged", async () => {
  const e = env();
  const snap = snapshot(1);
  const res = await publish(e, snap);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.status, "published");
  assert.equal(out.hash, snap.hash);
  assert.deepEqual(out.counts, snap.counts);

  const got = await call(e, "/api/catalog", { token: await visitor() });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("Content-Encoding"), "gzip");
  assert.equal(got.headers.get("ETag"), `"${"0".repeat(63)}1"`);
  assert.equal(got.headers.get("Cache-Control"), "private, no-cache");
  assert.deepEqual(await gunzipJson(got), snap);

  const again = await call(e, "/api/catalog", { token: await visitor(), headers: { "If-None-Match": `W/${got.headers.get("ETag")}` } });
  assert.equal(again.status, 304);

  const status = await call(e, "/api/admin/status", { token: await publisher() });
  assert.equal((await status.json()).hash, snap.hash);

  const same = await publish(e, snap);
  assert.equal((await same.json()).status, "unchanged");
});

test("only the publisher's token may publish", async () => {
  const e = env();
  // A visitor's token is for the other application.
  assert.equal((await publish(e, snapshot(1), { token: await visitor() })).status, 403);
  // A token for the admin application from some other service token.
  const stranger = await sign(team, { aud: [AUD_ADMIN], common_name: "someone-else.access" });
  assert.equal((await publish(e, snapshot(1), { token: stranger })).status, 403);
  // The publisher's token is not a visitor's.
  assert.equal((await call(e, "/api/catalog", { token: await publisher() })).status, 403);
  assert.equal(e.CATALOG.objects.size, 0);
});

test("a cut-short or malformed upload is refused and nothing changes", async () => {
  const e = env();
  assert.equal((await publish(e, snapshot(1), { tamper: true })).status, 400);
  const bad = await call(e, "/api/admin/catalog", {
    token: await publisher(), method: "PUT",
    headers: { "X-Catalog-Hash": "md5:abc", "X-Body-Sha256": "0".repeat(64) }, body: "x",
  });
  assert.equal(bad.status, 400);
  const plain = new TextEncoder().encode("{}");
  const notGzip = await call(e, "/api/admin/catalog", {
    token: await publisher(), method: "PUT",
    headers: { "X-Catalog-Hash": snapshot(1).hash, "X-Body-Sha256": await sha256Hex(plain) }, body: plain,
  });
  assert.equal(notGzip.status, 400);
  assert.equal(e.CATALOG.objects.size, 0);
});

test("old snapshots are pruned, the live one never is", async () => {
  const e = env();
  for (let n = 1; n <= KEEP_SNAPSHOTS + 4; n++) assert.equal((await publish(e, snapshot(n))).status, 200);
  const keys = [...e.CATALOG.objects.keys()].filter((k) => k.startsWith("snapshots/"));
  assert.equal(keys.length, KEEP_SNAPSHOTS);
  const live = JSON.parse(new TextDecoder().decode(e.CATALOG.objects.get(CURRENT_KEY).bytes));
  assert.ok(keys.includes(live.key));
  assert.equal(live.hash, snapshot(KEEP_SNAPSHOTS + 4).hash);
});

test("when Access's keys cannot be fetched the answer is 'try again', not 'denied'", async () => {
  globalThis.fetch = async () => new Response("down", { status: 502 });
  const res = await call(env(), "/", { token: await visitor() });
  assert.equal(res.status, 503);
});
