// schema.ts -- the D1 schema (Phase 3; meta-repo docs/dj-client-catalog.md section 5.5).
//
// The Worker applies it to itself: before its first database call in an isolate, it
// runs every migration that schema_migrations doesn't list yet, each one as a single
// D1 batch (one transaction). So a deploy needs no wrangler step and no D1 permission
// on the deploy token, and new code never meets an old schema: the first request
// that needs the database brings it up to date.
//
// APPEND ONLY. Never edit or reorder a migration that has shipped; add the next id.
// Deletes are soft (deleted_at) so the change feed can carry them.

export interface Migration {
  id: number;
  name: string;
  sql: string[];          // one statement each
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "gigs, members, requests, invites, changes, misses",
    sql: [
      `CREATE TABLE gigs (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        date              TEXT,                   -- YYYY-MM-DD, the day of the event
        venue             TEXT,
        status            TEXT NOT NULL DEFAULT 'planning'
                          CHECK (status IN ('planning', 'locked', 'played', 'archived')),
        requests_close_at TEXT,                   -- ISO instant; NULL = open until locked
        must_cap          INTEGER NOT NULL DEFAULT 20,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      )`,
      `CREATE TABLE members (
        gig_id     TEXT NOT NULL REFERENCES gigs (id),
        email      TEXT NOT NULL,                 -- lower case
        name       TEXT,
        role       TEXT NOT NULL CHECK (role IN ('host', 'planner', 'guest')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (gig_id, email)
      )`,
      "CREATE INDEX members_by_email ON members (email)",
      `CREATE TABLE requests (
        id          TEXT PRIMARY KEY,
        gig_id      TEXT,                         -- NULL = a prospect's own list
        email       TEXT NOT NULL,                -- whose list it is on
        song_key    TEXT,                         -- the catalog's song key; NULL for a wish
        version_key TEXT,                         -- 'discogs_id:position' when one version was chosen
        artist      TEXT NOT NULL,                -- as shown when it was requested
        title       TEXT NOT NULL,
        mix         TEXT,
        tier        TEXT NOT NULL CHECK (tier IN ('must', 'want', 'dnp', 'wish')),
        rank        INTEGER NOT NULL,
        moment      TEXT,
        note        TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      )`,
      "CREATE INDEX requests_by_list ON requests (email, gig_id, tier, rank) WHERE deleted_at IS NULL",
      "CREATE INDEX requests_by_gig ON requests (gig_id) WHERE deleted_at IS NULL",
      // Who should be in the Access group "DJ clients". The Living Room mini applies a
      // pending row through the Cloudflare API and reports back (the API token that can
      // edit Access never sits in this internet-facing Worker).
      `CREATE TABLE invites (
        email      TEXT PRIMARY KEY,
        action     TEXT NOT NULL CHECK (action IN ('add', 'remove')),
        state      TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'failed')),
        gig_id     TEXT,
        error      TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // The feed the Living Room mini pulls: list-change pushes now, the ledger in Phase 4.
      `CREATE TABLE changes (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        entity    TEXT NOT NULL,                  -- request | gig | member | invite | list
        entity_id TEXT NOT NULL,
        op        TEXT NOT NULL,                  -- add | update | move | reorder | delete | remove
        gig_id    TEXT,
        email     TEXT,                           -- whose list or membership
        actor     TEXT,                           -- who did it
        detail    TEXT,                           -- small JSON for a summary line
        at        TEXT NOT NULL
      )`,
      "CREATE INDEX changes_by_time ON changes (at)",
      // Searches that found nothing: what clients want that the crates lack. No identity.
      `CREATE TABLE misses (
        day TEXT NOT NULL,
        q   TEXT NOT NULL,
        n   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, q)
      )`,
    ],
  },
];

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

// Bring a database up to date. Two isolates can start at once after a deploy: the
// loser's batch fails on a table that now exists and rolls back whole, and it then
// finds the migration recorded -- the only failure it forgives.
export async function migrate(db: D1Database, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
  await db.prepare(LEDGER).run();
  const { results } = await db.prepare("SELECT id FROM schema_migrations").all<{ id: number }>();
  const have = new Set(results.map((r) => r.id));
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (have.has(m.id)) continue;
    try {
      await db.batch([
        ...m.sql.map((s) => db.prepare(s)),
        db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .bind(m.id, m.name, new Date().toISOString()),
      ]);
      applied.push(m.id);
    } catch (e) {
      const done = await db.prepare("SELECT id FROM schema_migrations WHERE id = ?").bind(m.id).first<number>("id");
      if (done === null) throw e;
    }
  }
  return applied;
}

// Once per database object per isolate; a failure is retried by the next request.
const ready = new WeakMap<D1Database, Promise<unknown>>();

export function ensureSchema(db: D1Database): Promise<unknown> {
  let p = ready.get(db);
  if (!p) {
    p = migrate(db).catch((e) => {
      ready.delete(db);
      throw e;
    });
    ready.set(db, p);
  }
  return p;
}
