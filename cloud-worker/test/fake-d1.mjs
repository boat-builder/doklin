// An in-memory stand-in for the D1 binding, over node's own SQLite
// (`node:sqlite`, experimental in 22 — the warning it prints on import is
// expected). Real SQL, so the schema runner's `CREATE TABLE IF NOT EXISTS`,
// its guarded `UPDATE … WHERE schema_version = …` and the `changes` it reads
// back are exercised rather than mimed; only the shapes D1 wraps them in are
// faked.
//
// The D1 surface the worker uses: prepare / bind / run / first / all, and
// batch as one transaction (D1 rolls a batch back if any statement fails,
// which is what the lease upsert in docs/teams-plan.md §3.4 will rest on).
//
// `queries` records every statement prepared, so a test can assert that an
// isolate migrates once and then stops asking.
import { DatabaseSync } from "node:sqlite";

class FakeD1Statement {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params ?? [];
  }

  bind(...params) {
    return new FakeD1Statement(this.db, this.sql, params);
  }

  /** D1 hands back plain objects; node:sqlite's rows have a null prototype. */
  #rows() {
    return this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r }));
  }

  #meta(info) {
    return {
      changes: info?.changes ?? 0,
      last_row_id: Number(info?.lastInsertRowid ?? 0),
      duration: 0,
      rows_read: 0,
      rows_written: info?.changes ?? 0,
    };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: this.#meta(info) };
  }

  async first(column) {
    const row = this.#rows()[0];
    if (row === undefined) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async all() {
    const results = this.#rows();
    return { success: true, results, meta: this.#meta(null) };
  }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
    /** Every statement prepared through this binding, in order. */
    this.queries = [];
  }

  prepare(sql) {
    this.queries.push(sql);
    return new FakeD1Statement(this.db, sql);
  }

  async exec(sql) {
    this.queries.push(sql);
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }

  /** All or nothing, the way D1's batch is. */
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /* ---------- what tests look at ---------- */

  /** The tables that exist, sorted — sqlite's own bookkeeping left out. */
  tables() {
    return this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
  }

  /** One scalar, for asserting on a row without ceremony. */
  value(sql, ...params) {
    const row = this.db.prepare(sql).get(...params);
    return row === undefined ? undefined : Object.values(row)[0];
  }

  rows(sql, ...params) {
    return this.db.prepare(sql).all(...params).map((r) => ({ ...r }));
  }
}

/** A binding that is there and does not work — a database deleted out from
 *  under a deployed worker. Every route must survive one. */
export const brokenD1 = () => ({
  prepare() {
    throw new Error("D1_ERROR: no such database");
  },
  async batch() {
    throw new Error("D1_ERROR: no such database");
  },
  async exec() {
    throw new Error("D1_ERROR: no such database");
  },
});
