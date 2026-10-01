# vinyl-crates — Crates, the client catalog site

A Cloudflare Worker, plus a static page, at **crates.bobshrimp.com**: the login-only,
searchable catalog of David's records for DJ clients. Read `README.md` first, then the
meta-repo `dschifman/vinyl` `CLAUDE.md` (machines, secrets, conventions) and
`docs/dj-client-catalog.md` (the design and its phases).

## Always name the machine

Every command handed to David says which machine's terminal it runs on, immediately
before the command. That includes PR bodies and docs. The machines are:

- **The Living Room mini, 192.168.1.249.** The backend, `~/VinylID`. The publisher,
  `secrets.json` and `tools/crates_access.py` all live here.
- **Any machine with Node 22.18+, in a checkout of this repo.** For `npm` commands.
- **The Cloudflare dashboard and GitHub settings.** For browser steps; say so.

## Where it runs

**On Cloudflare, not on either Mac mini.** Merging to `main` deploys it through
`.github/workflows/deploy.yml`, using the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repo secrets. The snapshot it serves comes from vinyl-command's
`client_catalog_publish.py` on the Living Room mini. That file builds with
`client_catalog.py` and PUTs to `/api/admin/catalog` with the Access service token
`dj-catalog-publisher`.

## Invariants (each has a test)

- **Fail closed.** Every request, assets included (`run_worker_first: true`), must carry a
  valid Access JWT for the right application (`src/access.ts`):
  - the signature checks out against the team's keys
  - the issuer is `https://<TEAM_DOMAIN>`
  - it has not expired
  - its `aud` includes `ACCESS_AUD_SITE`, or `ACCESS_AUD_ADMIN` for `/api/admin/*`
  - on admin requests, `common_name` equals `PUBLISHER_CLIENT_ID`

  With any of the four vars empty, everything gets a 503. Never add a bypass, a debug
  header or an "allow if Access is down" path.
- **No second door.** `workers_dev` and `preview_urls` stay `false`, and the only route is
  the Access-guarded custom domain.
- **The Worker never parses a snapshot.** The free plan allows 10 ms of CPU a request, and
  `JSON.parse` of 3 MB blows straight through that. Uploads are checked by `X-Body-Sha256`
  and gzip magic, stored as sent, and served with `encodeBody: "manual"`. The snapshot's
  own `hash` is the ETag.
- **Page code builds DOM with `textContent` only.** Catalog text is data. The CSP is
  `'self'` only: no CDNs, fonts, analytics or inline script.
- **`public/search.js` `norm()` mirrors vinyl-command `client_catalog.norm()`.** Change
  both together, or keys and typing fold differently.
- **The snapshot schema (v1) is owned by vinyl-command** (`client_catalog.build()`):
  - songs: `k` key, `a` artist, `t` title, `y` original year, `b` genre buckets, `v`
    versions as `[release id, position, mix, seconds, credits]`, `m` occasion moments
  - `releases`: `a`, `t`, `y`, `py` pressing year, `f` format, `l` label, `c` catno, `b`
  - plus `buckets`, `occasions`, `counts`, `hash` and `built_at`

  Read it from that code, not from memory.

## Versioning

`VERSION` in `src/worker.ts` is a single running counter (1.0 → 1.1 → 1.2). Bump it in
every PR that changes behaviour, and name it in the commit subject as `(crates 1.1)`.
Docs-only PRs bump nothing. The page footer shows it, from `/api/me`, and every response
carries `X-Crates-Version`.

## Tests

On any machine with Node 22.18+, in this repo: `npm run check`. That runs the typecheck,
`node --test` and a dry-run build. CI runs the same on every PR.
