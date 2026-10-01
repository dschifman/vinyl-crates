// worker.ts -- Crates: the login-only, searchable catalog of David's records
// for DJ clients (meta-repo dschifman/vinyl docs/dj-client-catalog.md).
//
// Phase 2, "clients can browse":
//   GET  /                     the page (public/), searched in the browser
//   GET  /api/catalog          the current snapshot: gzip JSON, ETag = its hash
//   GET  /api/me               who is signed in
//   PUT  /api/admin/catalog    the Living Room mini publishes a new snapshot
//   GET  /api/admin/status     what is live, for the publisher
//
// Every request -- page, assets and API alike -- must carry a valid Access
// token for the right application (src/access.ts). Nothing is served before
// TEAM_DOMAIN and both AUD tags are configured: until then every request gets
// a 503. The Worker never parses a snapshot (the free plan allows 10 ms of CPU
// a request); it checks the upload's checksum and stores the bytes as sent.

import { verifyAccessJwt, type AccessClaims } from "./access.ts";

export interface Env {
  ASSETS: Fetcher;
  CATALOG: R2Bucket;
  TEAM_DOMAIN: string;          // <team>.cloudflareaccess.com
  ACCESS_AUD_SITE: string;      // AUD tag of the "Crates" Access application
  ACCESS_AUD_ADMIN: string;     // AUD tag of the "Crates publisher" application (/api/admin)
  PUBLISHER_CLIENT_ID: string;  // Client ID of the dj-catalog-publisher service token
}

// One running counter, bumped by every PR that changes behaviour (the same rule as
// vinyl-command's api/worker and the iOS app). The page shows it in its footer.
export const VERSION = "1.2";

export const CURRENT_KEY = "current.json";
export const SNAPSHOT_PREFIX = "snapshots/";
export const KEEP_SNAPSHOTS = 10;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Robots-Tag": "noindex, nofollow",
};

export interface Current {
  hash: string;
  key: string;
  built_at: string;
  published_at: string;
  bytes: number;
  counts: Record<string, unknown>;
}

function secure(extra: Record<string, string> = {}): Headers {
  const h = new Headers(extra);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  h.set("X-Crates-Version", VERSION);
  return h;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: secure({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }),
  });
}

function text(status: number, body: string): Response {
  return new Response(body + "\n", {
    status,
    headers: secure({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

function configured(env: Env): boolean {
  return Boolean(env.TEAM_DOMAIN && env.ACCESS_AUD_SITE && env.ACCESS_AUD_ADMIN && env.PUBLISHER_CLIENT_ID);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readCurrent(env: Env): Promise<Current | null> {
  const obj = await env.CATALOG.get(CURRENT_KEY);
  if (!obj) return null;
  try {
    const cur = (await obj.json()) as Current;
    return cur && HASH_RE.test(cur.hash) && typeof cur.key === "string" ? cur : null;
  } catch {
    return null;
  }
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v.replace(/^W\//, "") === etag;
  });
}

async function getCatalog(request: Request, env: Env): Promise<Response> {
  const cur = await readCurrent(env);
  if (!cur) return json(503, { error: "No catalog has been published yet." });
  const etag = `"${cur.hash.slice("sha256:".length)}"`;
  const cache = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers: secure(cache) });
  }
  const obj = await env.CATALOG.get(cur.key);
  if (!obj) return json(503, { error: "The published catalog is missing; it will be sent again." });
  return new Response(request.method === "HEAD" ? null : obj.body, {
    status: 200,
    headers: secure({
      ...cache,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Encoding": "gzip",
      "X-Catalog-Built-At": cur.built_at,
    }),
    encodeBody: "manual",                  // the bytes are already gzip
  });
}

async function prune(env: Env, keep: string): Promise<void> {
  const listed = await env.CATALOG.list({ prefix: SNAPSHOT_PREFIX, limit: 1000 });
  const older = listed.objects
    .filter((o) => o.key !== keep)
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
  const drop = older.slice(KEEP_SNAPSHOTS - 1).map((o) => o.key);
  if (drop.length) await env.CATALOG.delete(drop);
}

async function putCatalog(request: Request, env: Env): Promise<Response> {
  const hash = request.headers.get("X-Catalog-Hash") ?? "";
  const bodySha = (request.headers.get("X-Body-Sha256") ?? "").toLowerCase();
  const builtAt = (request.headers.get("X-Catalog-Built-At") ?? "").slice(0, 40);
  if (!HASH_RE.test(hash) || !SHA_RE.test(bodySha)) {
    return json(400, { error: "X-Catalog-Hash and X-Body-Sha256 are required." });
  }
  let counts: Record<string, unknown> = {};
  const rawCounts = request.headers.get("X-Catalog-Counts");
  if (rawCounts && rawCounts.length <= 2000) {
    try {
      const parsed = JSON.parse(rawCounts);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) counts = parsed;
    } catch {
      return json(400, { error: "X-Catalog-Counts is not JSON." });
    }
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) return json(413, { error: "Snapshot too large." });
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return json(400, { error: "Empty body." });
  if (body.byteLength > MAX_UPLOAD_BYTES) return json(413, { error: "Snapshot too large." });
  const head = new Uint8Array(body, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return json(400, { error: "The body must be gzip." });
  if (hex(await crypto.subtle.digest("SHA-256", body)) !== bodySha) {
    return json(400, { error: "Body checksum mismatch: the upload was cut short or altered." });
  }

  const live = await readCurrent(env);
  if (live && live.hash === hash) return json(200, { status: "unchanged", ...live });

  const key = `${SNAPSHOT_PREFIX}${hash.slice("sha256:".length)}.json.gz`;
  await env.CATALOG.put(key, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8", contentEncoding: "gzip" },
    customMetadata: { hash, built_at: builtAt },
  });
  const current: Current = {
    hash, key, built_at: builtAt, published_at: new Date().toISOString(), bytes: body.byteLength, counts,
  };
  await env.CATALOG.put(CURRENT_KEY, JSON.stringify(current), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await prune(env, key);
  return json(200, { status: "published", ...current });
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  const headers = secure();
  res.headers.forEach((v, k) => {
    if (!headers.has(k)) headers.set(k, v);
  });
  // No hashed file names: always revalidate, so a deploy shows up at once.
  headers.set("Cache-Control", "no-cache");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!configured(env)) return text(503, "Crates isn't set up yet.");

  const admin = url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return text(403, "Sign in required.");
  let claims: AccessClaims | null;
  try {
    claims = await verifyAccessJwt(token, {
      teamDomain: env.TEAM_DOMAIN,
      audience: admin ? env.ACCESS_AUD_ADMIN : env.ACCESS_AUD_SITE,
    });
  } catch (e) {
    console.error("access keys unavailable", String(e));
    return text(503, "Sign-in check unavailable. Try again in a minute.");
  }
  if (!claims) return text(403, "Sign in required.");

  if (admin) {
    if (!claims.common_name || claims.common_name !== env.PUBLISHER_CLIENT_ID) return text(403, "Forbidden.");
    if (url.pathname === "/api/admin/catalog" && request.method === "PUT") return putCatalog(request, env);
    if (url.pathname === "/api/admin/status" && request.method === "GET") {
      return json(200, (await readCurrent(env)) ?? { hash: null });
    }
    return json(404, { error: "Not found." });
  }

  if (!claims.email) return text(403, "Sign in required.");   // a service token is not a visitor
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed.");
  if (url.pathname === "/api/catalog") return getCatalog(request, env);
  if (url.pathname === "/api/me") return json(200, { email: claims.email, version: VERSION });
  if (url.pathname.startsWith("/api/")) return json(404, { error: "Not found." });
  return serveAsset(request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      console.error("unhandled", String(e));
      return text(500, "Something went wrong.");
    }
  },
} satisfies ExportedHandler<Env>;
