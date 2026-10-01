// Shared test fixtures: an Access team with a real RSA key, signed tokens,
// an in-memory R2 bucket, a D1 over real SQLite (d1.mjs) and a stand-in for
// the static-assets binding.

import { MemoryD1 } from "./d1.mjs";

export const TEAM = "crates-test.cloudflareaccess.com";
export const AUD_SITE = "a".repeat(64);
export const AUD_ADMIN = "b".repeat(64);
export const PUBLISHER = "publisher-client-id.access";
export const OWNER = "dj@example.com";

const enc = new TextEncoder();

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function makeTeam(kid = "key-1") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export async function sign(team, claims, { kid = team.kid, alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: `https://${TEAM}`, iat: now, nbf: now, exp: now + 3600, ...claims };
  const head = b64url(enc.encode(JSON.stringify({ alg, kid, typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", team.privateKey, enc.encode(`${head}.${payload}`));
  return `${head}.${payload}.${b64url(new Uint8Array(sig))}`;
}

// A fetch that answers the team's certs URL and counts the calls.
export function certsFetcher(...teams) {
  const f = async (url) => {
    f.calls += 1;
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("no", { status: 404 });
    return Response.json({ keys: teams.map((t) => t.jwk) });
  };
  f.calls = 0;
  return f;
}

export class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.clock = 1_700_000_000_000;
  }
  async put(key, value, opts = {}) {
    const bytes = typeof value === "string" ? enc.encode(value) : new Uint8Array(value);
    this.clock += 1000;
    this.objects.set(key, { bytes, uploaded: new Date(this.clock), httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata });
  }
  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.bytes;
    return {
      key, uploaded: o.uploaded, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata,
      get body() { return new Response(bytes).body; },
      async arrayBuffer() { return bytes.slice().buffer; },
      async text() { return new TextDecoder().decode(bytes); },
      async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
    };
  }
  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, uploaded: o.uploaded, size: o.bytes.length }));
    return { objects, truncated: false };
  }
  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}

export function assets() {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/" || path === "/index.html") {
        return new Response("<!doctype html><title>Crates</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"page"', "Cache-Control": "public, max-age=3600" },
        });
      }
      if (["/dj", "/dj/", "/dj.html", "/dj.js", "/dj.css"].includes(path)) {
        return new Response("the DJ's page", { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

export function env(overrides = {}) {
  return {
    ASSETS: assets(),
    CATALOG: new MemoryR2(),
    DB: new MemoryD1(),
    OWNER_EMAIL: OWNER,
    TEAM_DOMAIN: TEAM,
    ACCESS_AUD_SITE: AUD_SITE,
    ACCESS_AUD_ADMIN: AUD_ADMIN,
    PUBLISHER_CLIENT_ID: PUBLISHER,
    ...overrides,
  };
}

export async function gzipJson(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The page's way of calling the API: JSON, and the X-Crates header on writes.
export function caller(worker, e, token) {
  return async (method, path, body) => {
    const headers = new Headers({ "Cf-Access-Jwt-Assertion": await token });
    if (method !== "GET") {
      headers.set("X-Crates", "1");
      if (body !== undefined) headers.set("Content-Type", "application/json");
    }
    const res = await worker.fetch(new Request(`https://crates.bobshrimp.com${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), e);
    const type = res.headers.get("Content-Type") || "";
    return { status: res.status, body: type.includes("json") ? await res.json() : await res.text(), headers: res.headers };
  };
}
