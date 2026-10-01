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
  ("beyonce", "ymca"). Indexing takes ~110 ms; a search takes under 10 ms.
- **Filters:** a Genre dropdown and a Style dropdown inside it sit under the search box
  (House → Deep House, Garage House …; the styles are Discogs', carried by the snapshot
  since vinyl-command api 5.63). Weddings and bar/bat mitzvahs come next, then decade and
  format under "More filters". A style matches a song when any of its versions is on a
  record with that style.
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

**Done on 2026-10-01.** The site went live that day. The steps stay here for a rebuild, in
another account or after a teardown.

Each step says where it happens. Commands for the Living Room mini (.249) log in to it
themselves, so they paste into the Terminal on any Mac at home. If that Terminal is
already logged in to the Living Room mini, type only the part inside the quotes. Away from
home, run `ssh vinyl-mini` first and paste the same command there.

1. **This repo** exists and the Claude GitHub app can reach it.
2. **The deploy key** goes in the browser, then GitHub:
   - In dash.cloudflare.com, open **My Profile → API Tokens → Create Token** and pick the
     **Edit Cloudflare Workers** template.
   - Set **Account Resources** to your account, and **Zone Resources** to *Specific zone →
     bobshrimp.com*. Create the token and copy it; Cloudflare shows it once.
   - Copy the **Account ID** from the right-hand column of any domain's Overview page.
   - In GitHub, under this repo's **Settings → Secrets and variables → Actions → New
     repository secret**, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   - In dash.cloudflare.com, switch on **R2 Object Storage** once for the account (the free
     plan is enough; it may ask for a payment method). Until then the deploy stops at "The
     R2 bucket exists" with `Please enable R2 through the Cloudflare Dashboard. [code:
     10042]`.
3. **Merge the vinyl-command PR** that adds the publisher and the tools. It deploys itself
   to the Living Room mini. Publishing stays off until step 5.
4. **The Access key** goes in the browser, then the Living Room mini:
   - In dash.cloudflare.com, under **My Profile → API Tokens → Create Token → Create Custom
     Token**, give it three Account permissions, all **Edit**: *Access: Apps and
     Policies*, *Access: Service Tokens*, and *Access: Organizations, Identity Providers,
     and Groups*. Set **Account Resources** to your account, then create the token and
     copy it. The Account ID is the same one as in step 2.
   - Run this in the Terminal on any Mac at home. It logs in to the Living Room mini
     (.249) and asks for the two values:
     ```
     ssh -t dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/set_secret.py CF_ACCESS_API_TOKEN CF_ACCOUNT_ID'
     ```
     At each prompt, paste the value and press Enter. Nothing shows on screen. It ends with
     `saved CF_ACCESS_API_TOKEN, CF_ACCOUNT_ID to … (values not shown)`. Never type a value
     into the command itself: the shell would keep it in its history.
   - To check, in the Terminal on any Mac at home (both lines should say `set`):
     ```
     ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/set_secret.py --check CF_ACCESS_API_TOKEN CF_ACCOUNT_ID'
     ```
5. **Create the Access pieces.** Claude can run this over SSH.
   - To see the plan, run this in the Terminal on any Mac at home. It changes nothing:
     ```
     ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/crates_access.py setup --owner-email OWNER_EMAIL'
     ```
   - To apply it, in the Terminal on any Mac at home:
     ```
     ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/crates_access.py setup --owner-email OWNER_EMAIL --apply'
     ```
     It prints the four `wrangler.jsonc` vars, none of which is a secret. The service
     token's secret goes straight into `secrets.json` on the Living Room mini and is never
     shown.
6. **Put the vars into `wrangler.jsonc`** in a PR and merge it. The site comes up, and
   within one maintainer cycle (~5 min) the Living Room mini publishes the catalog.
   `/system/health` there shows `crates_ok: true`.
   - For a minute or two after the Access pieces, the custom domain or a new version are
     created, some requests get a Cloudflare 500 page, an Access redirect or the old
     version while the change propagates. That happened on 2026-10-01 and cleared by
     itself. A publish that fails then is retried 30 minutes later.
7. **Invite someone and try it on a phone.** In the Terminal on any Mac at home:
   ```
   ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/crates_access.py clients add someone@example.com --apply'
   ```

## Running it

Each command here runs on the Living Room mini (.249) and pastes into the Terminal on any
Mac at home.

- **Who may sign in.** In the Terminal on any Mac at home:
  ```
  ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/crates_access.py clients list'
  ```
- **Invite a client.** In the Terminal on any Mac at home:
  ```
  ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/crates_access.py clients add EMAIL --apply'
  ```
- **Remove a client.** This signs them out everywhere too. In the Terminal on any Mac at
  home:
  ```
  ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/crates_access.py clients remove EMAIL --apply'
  ```
- **Is the catalog current?** `/system/health` on the Living Room mini carries
  `crates_ok`, `crates_published_at` and `crates_error`. In the Terminal on any Mac at
  home:
  ```
  ssh dschifman@192.168.1.249 'curl -s -H "X-Vinyl-Token: $(python3 -c "import json;print(json.load(open(\"$HOME/VinylID/secrets.json\"))[\"API_AUTH_TOKEN\"])")" localhost:8000/system/health | python3 -m json.tool | grep crates_'
  ```
- **Publish now.** Add `--dry-run` to build and compare without sending. In the Terminal
  on any Mac at home:
  ```
  ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python client_catalog_publish.py'
  ```
- **A new publisher secret.** In the Terminal on any Mac at home:
  ```
  ssh dschifman@192.168.1.249 'cd ~/VinylID && ./venv/bin/python tools/crates_access.py setup --owner-email OWNER_EMAIL --rotate-publisher --apply'
  ```
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
