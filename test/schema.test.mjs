import { test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS, migrate, ensureSchema } from "../src/schema.ts";
import { MemoryD1 } from "./d1.mjs";

const tables = (db) => db.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .map((r) => r.name);

test("a new database gets the whole schema, once", async () => {
  const db = new MemoryD1();
  assert.deepEqual(await migrate(db), [1]);
  assert.deepEqual(tables(db), ["changes", "gigs", "invites", "members", "misses", "requests", "schema_migrations"]);
  assert.deepEqual(db.rows("SELECT id FROM schema_migrations"), [{ id: 1 }]);
  assert.deepEqual(await migrate(db), [], "the second time there is nothing to do");
});

test("two isolates starting at once: one applies it, the other finds it applied", async () => {
  const db = new MemoryD1();
  const [a, b] = await Promise.all([migrate(db), migrate(db)]);
  assert.deepEqual([...a, ...b], [1]);
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM schema_migrations")[0].n, 1);
});

test("a later migration runs on an existing database; a broken one leaves nothing behind", async () => {
  const db = new MemoryD1();
  await migrate(db);
  const next = { id: 2, name: "a column", sql: ["ALTER TABLE gigs ADD COLUMN notes TEXT"] };
  assert.deepEqual(await migrate(db, [...MIGRATIONS, next]), [2]);
  assert.ok(db.rows("PRAGMA table_info(gigs)").some((c) => c.name === "notes"));
  const broken = { id: 3, name: "half", sql: ["CREATE TABLE half (x TEXT)", "NOT SQL AT ALL"] };
  await assert.rejects(migrate(db, [...MIGRATIONS, next, broken]));
  assert.ok(!tables(db).includes("half"), "rolled back whole");
  assert.deepEqual(db.rows("SELECT id FROM schema_migrations ORDER BY id").map((r) => r.id), [1, 2]);
});

test("ensureSchema runs once per database, and retries after a failure", async () => {
  const db = new MemoryD1();
  assert.equal(ensureSchema(db), ensureSchema(db));
  await ensureSchema(db);
  assert.equal(db.rows("SELECT COUNT(*) AS n FROM schema_migrations")[0].n, 1);
  let fail = true;
  const flaky = new MemoryD1();
  const prepare = flaky.prepare.bind(flaky);
  flaky.prepare = (sql) => {
    if (fail) throw new Error("D1 is having a moment");
    return prepare(sql);
  };
  await assert.rejects(ensureSchema(flaky));
  fail = false;
  await ensureSchema(flaky);
  assert.ok(tables(flaky).includes("requests"));
});
