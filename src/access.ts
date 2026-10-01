// access.ts -- check the Cloudflare Access token on every request.
//
// Access sits in front of crates.bobshrimp.com and stops anyone who has not
// signed in. This is the second lock: Access forwards a signed JWT in
// Cf-Access-Jwt-Assertion, and nothing is served unless that token verifies
// against the team's published keys AND names this application's audience.
// So a mistake in the Access setup (an app deleted, a path left uncovered, a
// workers.dev URL switched on) fails closed instead of opening the crate.

export interface AccessClaims {
  aud: string | string[];
  iss: string;
  exp: number;
  iat?: number;
  nbf?: number;
  email?: string;        // a person who signed in with an emailed code
  common_name?: string;  // a service token: its Client ID
  sub?: string;
  type?: string;
}

export interface VerifyOptions {
  teamDomain: string;    // e.g. "example.cloudflareaccess.com"
  audience: string;      // the Access application's AUD tag
  now?: number;          // ms; tests only
  fetcher?: typeof fetch;
}

const KEYS_TTL_MS = 60 * 60 * 1000;
const FORCED_REFRESH_GAP_MS = 5 * 60 * 1000;   // an unknown key id refetches at most this often
const CLOCK_SKEW_S = 60;

interface KeyCache {
  domain: string;
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

let cache: KeyCache | null = null;
let lastForcedRefresh = 0;

export function resetKeyCache(): void {
  cache = null;
  lastForcedRefresh = 0;
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function loadKeys(teamDomain: string, fetcher: typeof fetch, force: boolean): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (!force && cache && cache.domain === teamDomain && now - cache.fetchedAt < KEYS_TTL_MS) {
    return cache.keys;
  }
  const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs returned ${res.status}`);
  const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  if (keys.size === 0) throw new Error("Access certs held no RSA keys");
  cache = { domain: teamDomain, fetchedAt: now, keys };
  return keys;
}

// The claims when the token is genuine, current and for this application;
// null when it is not. Throws only when the keys cannot be fetched, which the
// caller reports as "try again" rather than "go away".
export async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]) as Partial<AccessClaims> | null;
  if (!header || !claims) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const fetcher = opts.fetcher ?? fetch;
  let keys = await loadKeys(opts.teamDomain, fetcher, false);
  let key = keys.get(header.kid);
  if (!key && Date.now() - lastForcedRefresh > FORCED_REFRESH_GAP_MS) {
    lastForcedRefresh = Date.now();          // Access rotates its keys: look once more
    keys = await loadKeys(opts.teamDomain, fetcher, true);
    key = keys.get(header.kid);
  }
  if (!key) return null;

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(parts[2]);
  } catch {
    return null;
  }
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!ok) return null;

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > now) return null;
  if (claims.iss !== `https://${opts.teamDomain}`) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!opts.audience || !aud.includes(opts.audience)) return null;
  return claims as AccessClaims;
}
