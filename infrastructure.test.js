"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const e = require("../server");
const { candles } = require("./fixtures");
const quiet = { error() {}, log() {} };
function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] || null },
    json: async () => body,
  };
}
function config(extra = {}) {
  return {
    ...e.runtimeConfig({
      SCAN_ENABLED: "false",
      REQUIRE_REMOTE_STORAGE: "false",
      RECORD_MARKET_CONTEXT: "false",
    }),
    ...extra,
  };
}

test("SQLite outbox survives closing and reopening", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-store-")),
    file = path.join(dir, "bot.sqlite");
  let s = new e.Store(file);
  s.put("a", "meta", { value: 1 });
  s.close();
  s = new e.Store(file);
  assert.equal(s.get("a").value, 1);
  assert.equal(s.pendingCount(), 1);
  s.close();
  fs.rmSync(dir, { recursive: true });
});
test("old acknowledgement cannot delete a newer pending revision", () => {
  const s = new e.Store(":memory:", { clock: () => 1000 });
  s.put("a", "meta", { value: 1 });
  const batch = s.pending();
  s.put("a", "meta", { value: 2 });
  s.acknowledge(batch);
  assert.equal(s.pendingCount(), 1);
  s.acknowledge(s.pending());
  assert.equal(s.pendingCount(), 0);
  s.close();
});
test("identical archive candles do not create repeated writes", () => {
  const s = new e.Store(":memory:");
  const a = candles(4);
  s.archive("synthetic", "BTC", a);
  s.acknowledge(s.pending());
  s.archive("synthetic", "BTC", a);
  assert.equal(s.pendingCount(), 0);
  assert.deepEqual(
    s.candles("synthetic", "BTC", a[0].time, a.at(-1).time + 3600),
    a,
  );
  s.close();
});
test("remote finalized signal replaces a stale dirty pending version", () => {
  const s = new e.Store(":memory:", { clock: () => 1000 });
  s.put("t", "signal", { finalResult: "pending" });
  s.mergeRemote([
    {
      id: "t",
      kind: "signal",
      payload: { finalResult: "loss", netR: -1 },
      updated_at: 900,
    },
  ]);
  assert.equal(s.get("t").finalResult, "loss");
  assert.equal(s.pendingCount(), 0);
  s.close();
});
test("dirty local nonterminal changes are not clobbered by recovery", () => {
  const s = new e.Store(":memory:", { clock: () => 1000 });
  s.put("x", "meta", { value: 2 });
  s.mergeRemote([
    { id: "x", kind: "meta", payload: { value: 1 }, updated_at: 900 },
  ]);
  assert.equal(s.get("x").value, 2);
  s.close();
});
test("remote recovery uses advancing keyset pages until empty", async () => {
  const records = [1, 2, 3, 4, 5].map((i) => ({
    id: String(i),
    kind: "meta",
    payload: { i },
    updated_at: 100 + i,
  }));
  let calls = 0;
  const remote = new e.RemoteStore(
    "https://example.supabase.co",
    "server-secret",
    {
      fetchImpl: async (url) => {
        calls++;
        const after = new URL(url).searchParams.get("id")?.slice(3) || "";
        return response(records.filter((r) => r.id > after).slice(0, 2));
      },
    },
  );
  const s = new e.Store(":memory:");
  assert.equal(await remote.recover(s), 5);
  assert.equal(calls, 4);
  assert.equal(s.list("meta").length, 5);
  s.close();
});
test("outbox retries persist on failed remote writes", async () => {
  const remote = new e.RemoteStore(
    "https://example.supabase.co",
    "server-secret",
    { fetchImpl: async () => response({}, 401) },
  );
  remote.holder = "test";
  const s = new e.Store(":memory:");
  s.put("x", "meta", { x: 1 });
  await assert.rejects(() => remote.flush(s));
  assert.equal(s.pendingCount(), 1);
  s.close();
});
test("successful fenced remote write acknowledges exact revisions", async () => {
  let body;
  const remote = new e.RemoteStore(
    "https://example.supabase.co",
    "server-secret",
    {
      fetchImpl: async (url, options) => {
        body = JSON.parse(options.body);
        return response(body.p_rows);
      },
    },
  );
  remote.holder = "holder";
  const s = new e.Store(":memory:");
  s.put("x", "meta", { x: 1 });
  await remote.flush(s);
  assert.equal(body.p_holder, "holder");
  assert.equal(s.pendingCount(), 0);
  s.close();
});
test("writeback cannot run before lease acquisition", async () => {
  const r = new e.RemoteStore("https://example.supabase.co", "secret");
  const s = new e.Store(":memory:");
  await assert.rejects(() => r.flush(s), /lease/);
  s.close();
});
test("HTTP 429 retries boundedly; 401 does not retry", async () => {
  let calls = 0,
    waits = [];
  const result = await e.requestJSON("https://example.com/feed", {
    fetchImpl: async () =>
      ++calls < 3
        ? response({}, 429, { "retry-after": "1" })
        : response({ ok: true }),
    wait: async (n) => waits.push(n),
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 1000]);
  calls = 0;
  await assert.rejects(
    () =>
      e.requestJSON("https://example.com/feed?api_key=secret", {
        fetchImpl: async () => {
          calls++;
          return response({}, 401);
        },
      }),
    (err) => !err.message.includes("secret"),
  );
  assert.equal(calls, 1);
});
test("Telegram token is redacted from request errors", async () => {
  await assert.rejects(
    () =>
      e.requestJSON("https://api.telegram.org/botTOPSECRET/sendMessage", {
        fetchImpl: async () => response({}, 401),
      }),
    (err) => !err.message.includes("TOPSECRET"),
  );
});
test("Bybit parser sorts ascending and uses quote turnover", () => {
  const c = e.parseBybit([
    ["7200000", "10", "12", "9", "11", "2", "22"],
    ["3600000", "9", "10", "8", "9", "3", "27"],
  ]);
  assert.equal(c[0].time, 3600);
  assert.equal(c[1].volume, 22);
});
test("CryptoCompare quote volume is not multiplied by price", () => {
  assert.equal(
    e.parseCC([
      { time: 0, open: 100, high: 101, low: 99, close: 100, volumeto: 1200 },
    ])[0].volume,
    1200,
  );
});
test("provider rejects stale data and never substitutes another timeframe", async () => {
  const a = candles(326),
    now = (a.at(-1).time + 3600) * 1000,
    m = new e.MarketData({ source: "bybit-linear", clock: () => now });
  m.candlePage = async () => a;
  await assert.rejects(() => m.latest("BTC", 320), /next open unavailable/);
});
test("provider excludes unfinished OHLC from features", async () => {
  const a = candles(325),
    forming = { ...a.at(-1), high: 999999, low: 0.000001 },
    m = new e.MarketData({
      source: "bybit-linear",
      clock: () => (forming.time + 20) * 1000,
    });
  m.candlePage = async () => [...a.slice(0, -1), forming];
  const p = await m.latest("BTC", 320);
  assert.equal(p.closed.at(-1).time, forming.time - 3600);
  assert.equal(p.nextOpen, forming.open);
});
test("funding values are normalized to percent only for display", async () => {
  const m = new e.MarketData({ source: "bybit-linear" });
  m.bybit = async (route) => ({
    time: 1700000000000,
    result:
      route === "tickers"
        ? { list: [{ fundingRate: "0.0001" }] }
        : { list: [] },
  });
  const c = await m.context("BTC");
  assert.equal(c.fundingPct, 0.01);
  assert.equal(c.scoringContribution, 0);
});
test("parallel scans share one in-flight execution", async () => {
  const b = new e.Bot(config(), {
    store: new e.Store(":memory:"),
    remote: null,
    logger: quiet,
  });
  let count = 0;
  b.scanOnce = async () => {
    count++;
    await new Promise((r) => setTimeout(r, 10));
    return "done";
  };
  assert.deepEqual(await Promise.all([b.scan(), b.scan(), b.scan()]), [
    "done",
    "done",
    "done",
  ]);
  assert.equal(count, 1);
  await b.stop();
});
test("unavailable remote persistence blocks a new recording scan", async () => {
  const b = new e.Bot(config({ requireRemote: true }), {
    store: new e.Store(":memory:"),
    remote: null,
    logger: quiet,
  });
  await b.initialize();
  await b.scan();
  assert.equal(b.lastScan, null);
  assert.equal(b.health().ready, false);
  await b.stop();
});
test("a restart marks in-flight Telegram delivery unknown rather than resending", async () => {
  const store = new e.Store(":memory:");
  store.put("n", "notification", { id: "n", status: "sending" });
  const b = new e.Bot(config(), { store, remote: null, logger: quiet });
  await b.initialize();
  assert.equal(store.get("n").status, "unknown");
  await b.stop();
});
test("scheduler invokes scans without dashboard requests", async () => {
  const b = new e.Bot(config({ scanEnabled: true, scanMs: 10 }), {
    store: new e.Store(":memory:"),
    remote: null,
    logger: quiet,
  });
  let count = 0;
  b.scan = async () => {
    count++;
  };
  await b.start();
  await new Promise((r) => setTimeout(r, 35));
  await b.stop();
  assert.ok(count >= 1);
});
test("trade notifications are opted in and SELL has a separate research gate", () => {
  const b = new e.Bot(
    config({ tgEnabled: true, tgUnrated: true, tgSell: false }),
    { store: new e.Store(":memory:"), remote: null, logger: quiet },
  );
  assert.equal(b.notificationAllowed({ conf: 0, dir: "BUY" }), true);
  assert.equal(b.notificationAllowed({ conf: 0, dir: "SELL" }), false);
  b.store.close();
});
test("mutating HTTP routes require admin auth and GET scan has no side effects", async () => {
  const b = new e.Bot(config({ adminToken: "test-admin" }), {
    store: new e.Store(":memory:"),
    remote: null,
    logger: quiet,
  });
  await b.initialize();
  let scans = 0;
  b.scan = async () => {
    scans++;
    return { ok: true };
  };
  const s = e.createServer(b);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + s.address().port;
  try {
    assert.equal((await fetch(base + "/api/scan")).status, 200);
    assert.equal(scans, 0);
    assert.equal(
      (await fetch(base + "/api/scan", { method: "POST" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/api/scan", {
          method: "POST",
          headers: { Authorization: "Bearer test-admin" },
        })
      ).status,
      200,
    );
    assert.equal(scans, 1);
    assert.equal(
      (
        await fetch(base + "/api/trade-alert", {
          headers: { Authorization: "Bearer test-admin" },
        })
      ).status,
      410,
    );
  } finally {
    await new Promise((r) => s.close(r));
    await b.stop();
  }
});
test("read protection and static traversal checks work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-public-"));
  fs.mkdirSync(path.join(dir, "public"));
  fs.writeFileSync(path.join(dir, "secret.txt"), "private");
  fs.symlinkSync(
    path.join(dir, "secret.txt"),
    path.join(dir, "public", "escape.txt"),
  );
  const b = new e.Bot(
    config({ readToken: "reader", publicDir: path.join(dir, "public") }),
    { store: new e.Store(":memory:"), remote: null, logger: quiet },
  );
  await b.initialize();
  const s = e.createServer(b);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + s.address().port;
  try {
    assert.equal((await fetch(base + "/api/full-log")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/full-log", {
          headers: { Authorization: "Bearer reader" },
        })
      ).status,
      200,
    );
    assert.equal((await fetch(base + "/escape.txt")).status, 404);
    assert.equal((await fetch(base + "/%2e%2e%2fsecret.txt")).status, 404);
  } finally {
    await new Promise((r) => s.close(r));
    await b.stop();
    fs.rmSync(dir, { recursive: true });
  }
});

test("rejected writeback schedules recovery without discarding pending data", async () => {
  const remote = new e.RemoteStore("https://example.supabase.co", "secret", {
    fetchImpl: async () => response({}, 409),
  });
  remote.holder = "holder";
  remote.recovered = true;
  const store = new e.Store(":memory:");
  try {
    store.put("x", "meta", { value: 1 });
    await assert.rejects(() => remote.flush(store));
    assert.equal(remote.recovered, false);
    assert.equal(store.pendingCount(), 1);
  } finally {
    store.close();
  }
});
test("remote candle restore keeps source, interval, pair and fixed bounds", async () => {
  const bars = candles(4),
    store = new e.Store(":memory:");
  const records = bars.map((c) => ({
    id: "c:" + c.time,
    kind: "candle",
    updated_at: c.time * 1000,
    payload: { source: "bybit-linear", sym: "BTC", interval: 3600, ...c },
  }));
  const remote = new e.RemoteStore("https://example.supabase.co", "secret", {
    fetchImpl: async (url) => {
      const q = new URL(url).searchParams,
        after = q.get("id")?.slice(3) || "";
      assert.equal(q.get("payload->>source"), "eq.bybit-linear");
      assert.equal(q.get("payload->>sym"), "eq.BTC");
      assert.equal(q.get("payload->interval"), "eq.3600");
      assert.equal(
        q.get("and"),
        `(payload->time.gte.${bars[0].time},payload->time.lt.${bars.at(-1).time + 3600})`,
      );
      return response(records.filter((r) => r.id > after).slice(0, 2));
    },
  });
  try {
    assert.equal(
      await remote.restoreCandles(
        store,
        "bybit-linear",
        "BTC",
        bars[0].time,
        bars.at(-1).time + 3600,
      ),
      4,
    );
    assert.deepEqual(
      store.candles(
        "bybit-linear",
        "BTC",
        bars[0].time,
        bars.at(-1).time + 3600,
      ),
      bars,
    );
    assert.equal(store.pendingCount(), 0);
  } finally {
    store.close();
  }
});
test("slow context collection begins after all price decisions and notification processing", async () => {
  const bars = candles(321),
    boundary = bars[320].time,
    events = [];
  const market = {
    latest: async (sym) => {
      events.push("price:" + sym);
      return { closed: bars.slice(0, 320), boundary, nextOpen: bars[320].open };
    },
    context: async (sym) => {
      events.push("context:" + sym);
      return { sym, scoringContribution: 0, observedAt: boundary + 10 };
    },
  };
  const bot = new e.Bot(config({ recordContext: true }), {
    store: new e.Store(":memory:"),
    market,
    remote: null,
    clock: () => (boundary + 10) * 1000,
    logger: quiet,
  });
  bot.deliverNotifications = async () => events.push("notifications");
  try {
    await bot.initialize();
    await bot.scan();
    assert.equal(bot.pairs.filter((p) => p.status === "ok").length, 12);
    assert.equal(events.filter((x) => x.startsWith("price:")).length, 12);
    assert.ok(
      events.indexOf("notifications") <
        events.findIndex((x) => x.startsWith("context:")),
    );
    assert.equal(bot.store.list("snapshot").length, 12);
    assert.ok(
      bot.store
        .list("snapshot")
        .every((s) => s.context.scoringContribution === 0),
    );
  } finally {
    await bot.stop();
  }
});
test("HTTP backtest worker returns the same frozen-data result without changing the recorder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-worker-"));
  const data = require("./fixtures").dataset({ count: 450, symbols: ["BTC"] });
  const file = path.join(dir, "dataset.json");
  e.writeJSON(file, data);
  const bot = new e.Bot(
    config({ dataDir: dir, datasetFile: file, adminToken: "test-admin" }),
    { store: new e.Store(":memory:"), remote: null, logger: quiet },
  );
  await bot.initialize();
  const before = e.policyHash(bot.cfg.strategy),
    server = e.createServer(bot);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const response = await fetch(base + "/api/backtest", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ config: { coinBias: true } }),
    });
    assert.equal(response.status, 202);
    for (let i = 0; i < 100 && bot.backtestJob.status === "running"; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(bot.backtestJob.status, "complete", bot.backtestJob.error);
    const expected = e.backtest(data, { ...bot.cfg.strategy, coinBias: true });
    assert.deepEqual(bot.backtestJob.results, expected);
    assert.equal(e.policyHash(bot.cfg.strategy), before);
    assert.deepEqual(
      e.readJSON(path.join(dir, "last-backtest.json")),
      expected,
    );
  } finally {
    await new Promise((r) => server.close(r));
    await bot.stop();
    fs.rmSync(dir, { recursive: true });
  }
});

test("recorder defaults to corrected control rather than unvalidated candidate filters", () => {
  const cfg = e.runtimeConfig({
    SCAN_ENABLED: "false",
    REQUIRE_REMOTE_STORAGE: "false",
  });
  for (const [key, value] of Object.entries(e.CORRECTED_CONTROL))
    assert.deepEqual(cfg.strategy[key], value);
  assert.notEqual(e.policyHash(cfg.strategy), e.policyHash(e.strategyConfig()));
});
