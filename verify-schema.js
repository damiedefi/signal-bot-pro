"use strict";
// Optional development-only dependency: npm install --no-save @electric-sql/pglite@0.3.14
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
async function verifySchema(
  moduleName = process.argv[2] || "@electric-sql/pglite",
) {
  const { PGlite } = require(moduleName),
    db = new PGlite(),
    checks = [];
  const check = (name, value) => {
    assert.ok(value, name);
    checks.push(name);
  };
  const denied = async (name, fn) => {
    await assert.rejects(fn);
    checks.push(name);
  };
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    const schema = fs.readFileSync(
      path.join(__dirname, "../schema.sql"),
      "utf8",
    );
    await db.exec(schema);
    checks.push("schema executes");
    const one = async (sql, params = []) =>
      (await db.query(sql, params)).rows[0];
    check(
      "first holder acquires lease",
      (await one("select public.bot_v6_acquire_lease('A',180) as ok")).ok,
    );
    check(
      "second holder blocked",
      !(await one("select public.bot_v6_acquire_lease('B',180) as ok")).ok,
    );
    const row = (id, finalResult, version) => ({
      id,
      kind: "signal",
      payload: { finalResult, netR: finalResult === "loss" ? -1 : null },
      updated_at: version,
    });
    const write = (holder, rows) =>
      db.query("select * from public.bot_v6_write_records($1,$2::jsonb)", [
        holder,
        JSON.stringify(rows),
      ]);
    await write("A", [row("s1", "pending", 100)]);
    checks.push("fenced batch insert");
    await denied("non-holder cannot write", () =>
      write("B", [row("bad", "pending", 100)]),
    );
    await db.exec(
      "update public.bot_v6_lease set expires_at=clock_timestamp()-interval '1 second';",
    );
    check(
      "expired lease permits takeover",
      (await one("select public.bot_v6_acquire_lease('B',180) as ok")).ok,
    );
    await denied("old holder fenced after takeover", () =>
      write("A", [row("old", "pending", 100)]),
    );
    await write("B", [row("s1", "loss", 101)]);
    await denied("resolved result cannot reopen", () =>
      write("B", [row("s1", "pending", 102)]),
    );
    check(
      "resolved result preserved",
      (
        await one(
          "select payload->>'finalResult' as state from public.bot_v6_records where id='s1'",
        )
      ).state === "loss",
    );
    await denied("stale revisions rejected", () =>
      write("B", [row("s1", "loss", 99)]),
    );
    await denied("batch failure is atomic", () =>
      write("B", [
        row("atomic", "pending", 100),
        { ...row("invalid", "pending", 100), kind: "invalid" },
      ]),
    );
    check(
      "failed batch wrote no first row",
      Number(
        (
          await one(
            "select count(*) as n from public.bot_v6_records where id='atomic'",
          )
        ).n,
      ) === 0,
    );
    await db.exec("set role anon;");
    await denied("anonymous reads denied", () =>
      db.query("select * from public.bot_v6_records"),
    );
    await denied("anonymous lease calls denied", () =>
      db.query("select public.bot_v6_acquire_lease('anon',180)"),
    );
    await db.exec("reset role;");
    await db.exec("set role service_role;");
    await denied("service cannot bypass fenced write RPC", () =>
      db.query(
        "insert into public.bot_v6_records values('direct','meta','{}',100)",
      ),
    );
    await db.exec("reset role;");
    await db.exec(schema);
    check(
      "migration can rerun without deleting history",
      Number(
        (await one("select count(*) as n from public.bot_v6_records")).n,
      ) === 1,
    );
    return {
      runtime: "PGlite PostgreSQL WASM (local)",
      passed: checks.length,
      checks,
      liveSupabaseTested: false,
    };
  } finally {
    await db.close();
  }
}
module.exports = { verifySchema };
if (require.main === module)
  verifySchema()
    .then((result) => {
      if (process.argv[3])
        fs.writeFileSync(
          process.argv[3],
          JSON.stringify(result, null, 2) + "\n",
        );
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
