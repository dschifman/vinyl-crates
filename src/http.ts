// http.ts -- responses, security headers and request bodies, shared by every route.

import { VERSION } from "./version.ts";

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

export function secure(extra: Record<string, string> = {}): Headers {
  const h = new Headers(extra);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  h.set("X-Crates-Version", VERSION);
  return h;
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: secure({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }),
  });
}

export function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body + "\n", {
    status,
    headers: secure({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra }),
  });
}

// A refusal the client can show as it is: the status says why, the message says what.
// (No TypeScript parameter properties: node --test strips types and cannot run them.)
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const MAX_BODY_BYTES = 16 * 1024;

// Writes from the page must be JSON and carry X-Crates: 1. A cross-site form can do
// neither without a CORS preflight, which this Worker never answers.
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  if (request.headers.get("X-Crates") !== "1") throw new HttpError(403, "Missing the X-Crates header.");
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send JSON.");
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "That is too much text.");
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "That is too much text.");
  try {
    const body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as T;
  } catch {
    throw new HttpError(400, "That isn't valid JSON.");
  }
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
