import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt, resetKeyCache } from "../src/access.ts";
import { TEAM, AUD_SITE, AUD_ADMIN, makeTeam, sign, certsFetcher } from "./helpers.mjs";

const team = await makeTeam("key-1");
const other = await makeTeam("key-1");     // same key id, different key: a forger
beforeEach(() => resetKeyCache());

const opts = (fetcher, extra = {}) => ({ teamDomain: TEAM, audience: AUD_SITE, fetcher, ...extra });

test("a genuine token for this application verifies", async () => {
  const f = certsFetcher(team);
  const token = await sign(team, { aud: [AUD_SITE], email: "client@example.com" });
  const claims = await verifyAccessJwt(token, opts(f));
  assert.equal(claims.email, "client@example.com");
  await verifyAccessJwt(token, opts(f));
  assert.equal(f.calls, 1, "the team's keys are fetched once and cached");
});

test("a token for another application is refused", async () => {
  const token = await sign(team, { aud: [AUD_ADMIN], email: "client@example.com" });
  assert.equal(await verifyAccessJwt(token, opts(certsFetcher(team))), null);
});

test("expired, not-yet-valid, wrong-issuer and forged tokens are refused", async () => {
  const f = certsFetcher(team);
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    await sign(team, { aud: [AUD_SITE], email: "x@y.z", exp: now - 3600 }),
    await sign(team, { aud: [AUD_SITE], email: "x@y.z", nbf: now + 3600 }),
    await sign(team, { aud: [AUD_SITE], email: "x@y.z", iss: "https://evil.cloudflareaccess.com" }),
    await sign(other, { aud: [AUD_SITE], email: "x@y.z" }),
  ];
  for (const token of cases) assert.equal(await verifyAccessJwt(token, opts(f)), null);
});

test("a tampered payload, an unsigned token and junk are refused", async () => {
  const f = certsFetcher(team);
  const token = await sign(team, { aud: [AUD_SITE], email: "client@example.com" });
  const [h, p, s] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ aud: [AUD_SITE], email: "boss@example.com", exp: 9e9, iss: `https://${TEAM}` }))
    .toString("base64url");
  assert.equal(await verifyAccessJwt(`${h}.${forgedPayload}.${s}`, opts(f)), null);
  const none = await sign(team, { aud: [AUD_SITE], email: "x@y.z" }, { alg: "none" });
  assert.equal(await verifyAccessJwt(none, opts(f)), null);
  for (const junk of ["", "a.b", "a.b.c", `${h}.${p}`, "...."]) {
    assert.equal(await verifyAccessJwt(junk, opts(f)), null);
  }
});

test("an empty audience never matches", async () => {
  const token = await sign(team, { aud: [""], email: "x@y.z" });
  assert.equal(await verifyAccessJwt(token, opts(certsFetcher(team), { audience: "" })), null);
});

test("a rotated key is picked up by refetching once", async () => {
  const rotated = await makeTeam("key-2");
  let keys = [team];
  const f = async (url) => {
    f.calls += 1;
    return Response.json({ keys: keys.map((k) => k.jwk) });
  };
  f.calls = 0;
  assert.ok(await verifyAccessJwt(await sign(team, { aud: [AUD_SITE], email: "x@y.z" }), opts(f)));
  keys = [team, rotated];
  assert.ok(await verifyAccessJwt(await sign(rotated, { aud: [AUD_SITE], email: "x@y.z" }), opts(f)));
  assert.equal(f.calls, 2);
  // An unknown key id does not refetch again straight away.
  const stranger = await makeTeam("key-3");
  assert.equal(await verifyAccessJwt(await sign(stranger, { aud: [AUD_SITE], email: "x@y.z" }), opts(f)), null);
  assert.equal(f.calls, 2);
});

test("keys that cannot be fetched throw, so the caller says 'try again'", async () => {
  const down = async () => new Response("down", { status: 502 });
  const token = await sign(team, { aud: [AUD_SITE], email: "x@y.z" });
  await assert.rejects(verifyAccessJwt(token, opts(down)));
});
