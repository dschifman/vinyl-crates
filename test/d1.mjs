// A stand-in for Cloudflare D1 over node:sqlite, so the Worker's real SQL runs
// against real SQLite in the tests. It starts empty, as a new D1 database does: the
// Worker creates its own schema (src/schema.ts). It keeps foreign keys on (D1 enforces
// them) and, like D1, refuses to bind `undefined`.

import { DatabaseSync } from "node:sqlite";

function bindable(values) {
  return values.map((v) => {
    if (v === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
}

class Statement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) {
    return new Statement(this.db, this.sql, bindable(values));
  }
  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.values);
    if (!row) return null;
    const plain = { ...row };
    return column === undefined ? plain : plain[column] ?? null;
  }
  async all() {
    const results = this.db.prepare(this.sql).all(...this.values).map((r) => ({ ...r }));
    return { results, success: true, meta: { rows_read: results.length } };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.values);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  _sync() {
    const stmt = this.db.prepare(this.sql);
    if (/^\s*(select|with)\b/i.test(this.sql)) {
      return { results: stmt.all(...this.values).map((r) => ({ ...r })), success: true, meta: {} };
    }
    const r = stmt.run(...this.values);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class MemoryD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) {
    return new Statement(this.db, sql);
  }
  // D1 runs a batch as one transaction: all of it or none of it.
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = statements.map((s) => s._sync());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql) {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
  // tests only
  rows(sql, ...values) {
    return this.db.prepare(sql).all(...values).map((r) => ({ ...r }));
  }
}
