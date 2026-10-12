import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { d1Prepare, expandD1 } from "./d1-sqlite.mjs";

test("numbered D1 placeholders expand and reuse the same bound value", () => {
  const query = expandD1("SELECT ?1 AS first, ?2 AS second, ?1 AS again", ["user", 3]);
  assert.equal(query.sql, "SELECT ? AS first, ? AS second, ? AS again");
  assert.deepEqual(query.args, ["user", 3, "user"]);
  assert.deepEqual(expandD1("SELECT ?", ["user"]).args, ["user"]);
  const sqlite = new DatabaseSync(":memory:");
  try {
    const row = sqlite.prepare(query.sql).get(...query.args);
    assert.equal(row.first, "user");
    assert.equal(row.second, 3);
    assert.equal(row.again, "user");
  } finally {
    sqlite.close();
  }
});

test("d1Prepare runs a repeated ?1 membership-style lookup", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("CREATE TABLE t(id TEXT, active INTEGER)");
    sqlite.prepare("INSERT INTO t(id, active) VALUES (?, 1)").run("user");
    const db = { prepare: d1Prepare(sqlite) };
    const row = await db.prepare("SELECT id FROM t WHERE id=?1 AND active=1 AND id=?1").bind("user").first();
    assert.equal(row.id, "user");
  } finally {
    sqlite.close();
  }
});
