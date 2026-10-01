// api.js -- the page's calls to the Worker. Writes are JSON and carry X-Crates: 1,
// which a cross-site form cannot send (the Worker refuses writes without it).

export async function api(method, path, body) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") {
    headers["X-Crates"] = "1";
    if (body !== undefined) headers["Content-Type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(path, {
      method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // An expired sign-in redirects to the Access login, which fetch cannot follow.
    throw new Error("Couldn't reach Crates. If this page has been open a while, reload it to sign in again.");
  }
  const type = res.headers.get("Content-Type") || "";
  const data = type.includes("json") ? await res.json().catch(() => ({})) : {};
  if (!res.ok) throw new Error(data.error || `Something went wrong (error ${res.status}). Reload the page and try again.`);
  return data;
}
