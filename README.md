# Crates

The login-only, searchable catalog of David's records for DJ clients, at
**https://crates.bobshrimp.com**. Design and phasing: `docs/dj-client-catalog.md` in the
`dschifman/vinyl` meta-repo. This is Phase 2, "clients can browse".

## How it works

```
Living Room mini (.249)                      Cloudflare                          a client's phone
vinyl-command                                                                     
  client_catalog.py builds the snapshot      Access: a code by email,
  client_catalog_publish.py, on change  ──▶  invited addresses only
    PUT /api/admin/catalog                   Worker (this repo)  ──▶  R2: current.json,
    (service token dj-catalog-publisher)       checks the Access token      snapshots/<hash>.json.gz
                                               on every request        ◀──  GET /api/catalog (0.7 MB gzip)
                                                                            searched in the browser
```

- **Nothing connects into the house.** The Living Room mini pushes a new snapshot when the
  collection changes. The Worker never calls home and never calls Discogs. A power cut at
  home doesn't take the site down.
- **The whole catalog loads once** (15,293 songs, 0.71 MB gzipped on 2026-10-01) and is
  searched in the browser by `public/search.js`. The search forgives typos ("dona sumer",
  "mikael jakson"), matches prefixes ("sylv") and ignores accents and punctuation
  ("beyonce", "ymca"). Indexing takes ~110 ms; a search takes under 10 ms. Weddings and
  bar/bat mitzvahs come first among the filters, ahead of genre, decade and format.
- **▶ Listen** opens a YouTube search for the song. No audio is hosted.

## Security

- **Cloudflare Access** guards the hostname. Application **Crates** covers the site:
  One-time PIN only, 1-month sessions, group **DJ clients** or the owner. Application
  **Crates publisher** covers `/api/admin`: service auth for one token.
  `vinyl-command/tools/crates_access.py` creates these and never uses an "Everyone" rule.
- **The Worker checks the Access JWT itself on every request**, page and assets included
  (`run_worker_first`). It verifies the signature against the team's keys, plus issuer,
  expiry and the audience of the right application. If the Access setup has a gap, the
  site fails closed.
- **It serves nothing until configured.** Until the four `vars` in `wrangler.jsonc` are
  filled in, every request gets a 503.
- **No second door.** `workers_dev` and `preview_urls` are off.
- **Strict headers on everything.** The CSP allows `'self'` only, with no third-party
  scripts, fonts or images, and adds `no-referrer`, `nosniff` and `frame-ancestors 'none'`.
  The page builds every element with `textContent`, never `innerHTML`.
- **What a client can see is facts about owned records only**: titles, artists, mixes,
  credits, labels, catalog numbers, years and formats. vinyl-command's
  `tools/test_client_catalog.py` pins that.

## Deploy

**Merging to `main` is the deploy.** `.github/workflows/deploy.yml` runs the typecheck,
the tests and a dry-run build on every PR. On `main` it also makes sure the R2 bucket
exists and runs `wrangler deploy`.

## Setup (once)

Each step says where it happens.

1. **This repo** exists and the Claude GitHub app can reach it.
2. **The deploy key** goes in the browser, then GitHub:
   - In dash.cloudflare.com, open **My Profile → API Tokens → Create Token** and pick the
     **Edit Cloudflare Workers** template.
   - Set **Account Resources** to your account, and **Zone Resources** to *Specific zone →
     bobshrimp.com*. Create the token and copy it; Cloudflare shows it once.
   - Copy the **Account ID** from the right-hand column of any domain's Overview page.
   - In GitHub, under this repo's **Settings → Secrets and variables → Actions → New
     repository secret**, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. **Merge the vinyl-command PR** that adds the publisher and the tools. It deploys itself
   to the Living Room mini. Publishing stays off until step 5.
4. **The Access key** goes in the browser, then the Living Room mini:
   - Under **My Profile → API Tokens → Create Token → Create Custom Token**, give it three
     Account permissions, all **Edit**: *Access: Apps and Policies*, *Access: Service
     Tokens*, and *Access: Organizations, Identity Providers, and Groups*. Set **Account
     Resources** to your account, then create the token.
   - Then, on the Living Room mini (.249), from any terminal:
     ```
     ssh dschifman@192.168.1.249
     cd ~/VinylID && ./venv/bin/python tools/set_secret.py CF_ACCESS_API_TOKEN CF_ACCOUNT_ID
     ```
     Paste each value at its prompt. Nothing is shown on screen.
5. **Create the Access pieces.** Claude can run this over SSH. On the Living Room mini
   (.249):
   ```
   cd ~/VinylID && ./venv/bin/python tools/crates_access.py setup --owner-email OWNER_EMAIL
   cd ~/VinylID && ./venv/bin/python tools/crates_access.py setup --owner-email OWNER_EMAIL --apply
   ```
   The first command shows the plan; the second applies it. It prints the four
   `wrangler.jsonc` vars. None of them is a secret.
6. **Put the vars into `wrangler.jsonc`** in a PR and merge it. The site comes up, and
   within one maintainer cycle (~5 min) the Living Room mini publishes the catalog.
   `/system/health` there shows `crates_ok: true`.
7. **Invite someone and try it on a phone.** On the Living Room mini (.249):
   ```
   cd ~/VinylID && ./venv/bin/python tools/crates_access.py clients add someone@example.com --apply
   ```

## Running it

All of these run on the Living Room mini (.249):

| | |
|---|---|
| Who may sign in | `cd ~/VinylID && ./venv/bin/python tools/crates_access.py clients list` |
| Invite a client | `cd ~/VinylID && ./venv/bin/python tools/crates_access.py clients add EMAIL --apply` |
| Remove a client (signs them out too) | `cd ~/VinylID && ./venv/bin/python tools/crates_access.py clients remove EMAIL --apply` |
| Is the catalog current? | `/system/health` → `crates_ok`, `crates_published_at`, `crates_error` |
| Publish now / preview | `cd ~/VinylID && ./venv/bin/python client_catalog_publish.py [--dry-run]` |
| New publisher secret | `cd ~/VinylID && ./venv/bin/python tools/crates_access.py setup --owner-email OWNER_EMAIL --rotate-publisher --apply` |

- **Seats.** The free plan has 50 seats. A seat is taken at a person's first sign-in and is
  freed when its idle time runs out, or by hand under Zero Trust → Users.
- **Roll back the site** by reverting the merge, or in the Cloudflare dashboard under
  **Workers & Pages → vinyl-crates → Deployments**.
- **Stop publishing** with `CLIENT_CATALOG_PUBLISH = False` in vinyl-command's `api.py`.
  The site keeps the last catalog it was sent.

## Working on it

These run in a checkout of this repo on any machine with Node 22.18 or newer:

```
npm ci
npm run check        # typecheck + tests + a dry-run build
```

`wrangler dev` answers 503 or 403, by design: there is no Access in front of it. Test the
page's logic in `test/search.test.mjs`, and the Worker's in `test/worker.test.mjs`. Those
use a real RSA key, signed tokens and an in-memory R2.
