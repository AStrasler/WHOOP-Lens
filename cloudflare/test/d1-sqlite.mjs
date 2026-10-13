// Cloudflare D1 accepts numbered SQLite placeholders and reuses ?1.
// node:sqlite 22.14 rejects ?1 with "column index out of range".
// Expand numbered placeholders into positional binds before executing.
export function expandD1(sql, args) {
  const indexes = [];
  const translated = sql.replace(/\?(\d+)/g, (_, number) => {
    indexes.push(Number(number));
    return "?";
  });
  return {
    sql: translated,
    args: indexes.length ? indexes.map((number) => args[number - 1]) : args,
  };
}

export function d1Prepare(sqlite) {
  return function prepare(sql) {
    let args = [];
    const statement = () => {
      const query = expandD1(sql, args);
      return sqlite.prepare(query.sql);
    };
    const bound = () => expandD1(sql, args).args;
    return {
      bind(...values) {
        args = values;
        return this;
      },
      async first() {
        return statement().get(...bound()) ?? null;
      },
      async all() {
        const query = expandD1(sql, args);
        const results = sqlite.prepare(query.sql).all(...query.args);
        // changes() is the last INSERT/UPDATE/DELETE on this connection.
        // A SELECT must not report the previous write's count.
        const writing = /^\s*(?:insert|update|delete)\b/i.test(query.sql);
        const changes = writing ? sqlite.prepare("SELECT changes() AS changes").get().changes : 0;
        return { success: true, results, meta: { changes } };
      },
      _exec() {
        const info = statement().run(...bound());
        return { success: true, meta: { changes: info.changes } };
      },
      async run() {
        const info = statement().run(...bound());
        return { success: true, meta: { changes: info.changes } };
      },
    };
  };
}

// D1 batch(): statements run in one implicit transaction; any failure rolls back.
export function d1Database(sqlite) {
  const prepare = d1Prepare(sqlite);
  return {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => s._exec());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
