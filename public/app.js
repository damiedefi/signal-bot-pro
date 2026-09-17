"use strict";
(() => {
  const PAIRS = [
    "BTC",
    "ETH",
    "BNB",
    "SOL",
    "DOGE",
    "AVAX",
    "XRP",
    "NEAR",
    "UNI",
    "INJ",
    "SUI",
    "TAO",
  ];
  const $ = (id) => document.getElementById(id);
  let token = "",
    busy = false,
    currentPairs = [];
  const numeric = (n) => typeof n === "number" && Number.isFinite(n);
  const number = (n, digits = 2) =>
    numeric(n)
      ? n.toLocaleString("en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })
      : "—";
  const r = (n) => (numeric(n) ? (n > 0 ? "+" : "") + number(n) + "R" : "—");
  const price = (n) => number(n, numeric(n) && n < 1 ? 5 : 2);
  const time = (seconds) =>
    numeric(seconds)
      ? new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16)
      : "—";
  function node(tag, text, className) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = String(text);
    if (className) n.className = className;
    return n;
  }
  function colored(el, value) {
    el.classList.remove("positive", "negative");
    if (numeric(value) && value !== 0)
      el.classList.add(value > 0 ? "positive" : "negative");
  }
  function cell(row, value, className) {
    const el = node("td", undefined, className);
    el.append(
      value instanceof Node
        ? value
        : document.createTextNode(String(value ?? "—")),
    );
    row.append(el);
    return el;
  }
  function empty(tbody, columns, message) {
    const row = node("tr"),
      td = cell(row, message, "empty");
    td.colSpan = columns;
    tbody.append(row);
  }
  function badge(value, kind = "") {
    return node("span", value, "badge " + kind);
  }
  async function get(route) {
    const res = await fetch(route, {
      headers: token ? { Authorization: "Bearer " + token } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) {
      $("access").hidden = false;
      throw new Error(
        "Read access is required. Enter the token to view this recorder.",
      );
    }
    if (!res.ok)
      throw new Error("Recorder request failed (" + res.status + ").");
    return res.json();
  }
  function renderPairs() {
    const tbody = $("pairs"),
      filter = $("pair-filter").value;
    tbody.replaceChildren();
    const pairs = PAIRS.map(
      (sym) =>
        currentPairs.find((p) => p.sym === sym) || {
          sym,
          status: "unavailable",
          error: "No scan received",
        },
    );
    for (const p of pairs) {
      const direction = p.signals?.[0]?.dir;
      if (filter === "unavailable" && p.status === "ok") continue;
      if (["BUY", "SELL"].includes(filter) && direction !== filter) continue;
      const row = node("tr");
      cell(row, p.sym + "/USD" + (p.source === "bybit-linear" ? "T" : ""));
      cell(row, price(p.price), "number");
      const change = cell(
        row,
        numeric(p.pct24h)
          ? (p.pct24h > 0 ? "+" : "") + number(p.pct24h) + "%"
          : "—",
        "number",
      );
      colored(change, p.pct24h);
      cell(row, p.regime || "—");
      cell(
        row,
        p.status === "ok"
          ? badge(
              direction ? "PAPER " + direction : "HOLD",
              direction?.toLowerCase(),
            )
          : badge("NO DATA", "warn"),
      );
      cell(row, p.conf >= 2 ? "★".repeat(p.conf) : "Unrated");
      const explanation =
        p.status !== "ok"
          ? p.error
          : p.disposition === "filtered"
            ? (p.reasons || []).join(" · ")
            : p.disposition;
      const detail = cell(row, explanation || "Waiting", "reason");
      detail.title = explanation || "Waiting";
      tbody.append(row);
    }
    if (!tbody.children.length) empty(tbody, 7, "No pairs match this filter.");
  }
  function renderTrades(trades) {
    const tbody = $("trades");
    tbody.replaceChildren();
    if (!trades.length)
      return empty(
        tbody,
        8,
        "No paper trades recorded for the current policy yet.",
      );
    for (const t of trades) {
      const row = node("tr");
      cell(row, time(t.entryTime));
      cell(row, t.sym);
      cell(row, badge(t.dir, t.dir?.toLowerCase()));
      for (const value of [t.entryPrice, t.sl, t.tp1])
        cell(row, price(value), "number");
      const outcome = t.outcomeError
        ? "Awaiting complete data"
        : t.finalResult === "pending"
          ? "Open"
          : t.exitReason === "time"
            ? "Time exit"
            : t.exitReason === "target"
              ? "Target"
              : "Stop";
      const label = cell(row, outcome + (t.ambiguous ? " · ambiguous" : ""));
      if (t.outcomeError) label.title = t.outcomeError;
      const net = cell(row, r(t.netR), "number");
      colored(net, t.netR);
      tbody.append(row);
    }
  }
  function renderStats(stats) {
    const s = stats.overall;
    $("expectancy").textContent = r(s.expectancy);
    colored($("expectancy"), s.expectancy);
    $("total-r").textContent = s.resolved ? r(s.totalR) : "—";
    colored($("total-r"), s.totalR);
    $("trade-count").textContent =
      s.resolved + " resolved · " + s.expired + " time exits";
    $("pending").textContent = s.pending;
    $("drawdown").textContent = s.resolved
      ? number(s.maxClosedTradeDrawdownR) + "R"
      : "—";
    $("directions").replaceChildren();
    for (const dir of ["BUY", "SELL"]) {
      const d = stats.byDir[dir],
        card = node("div", undefined, "direction-card");
      card.append(badge(dir, dir.toLowerCase()));
      const value = node("strong", r(d.expectancy));
      colored(value, d.expectancy);
      card.append(value);
      card.append(
        node("p", "Net R per resolved trade"),
        node("p", d.resolved + " resolved · " + d.pending + " open"),
      );
      $("directions").append(card);
    }
  }
  function renderStatus(health, cfg, scan, lab) {
    const rows = [
      [
        "Price source",
        cfg.source === "bybit-linear"
          ? "Bybit linear perpetuals"
          : "CryptoCompare CCCAGG",
      ],
      [
        "Pairs available",
        (scan.lastScan?.available ?? 0) + " / " + PAIRS.length,
      ],
      [
        "Persistence",
        health.persistence.connected && health.persistence.recovered
          ? "Connected · " + health.persistence.pendingWrites + " queued writes"
          : health.persistence.configured
            ? "Recovery pending"
            : health.persistence.required
              ? "Not configured"
              : "Local only",
      ],
      ["Quality stars", health.validation.stars],
      [
        "Notifications",
        health.telegramEnabled ? "Paper alerts enabled" : "Off",
      ],
    ];
    $("recorder").replaceChildren();
    for (const [label, value] of rows) {
      const row = node("div");
      row.append(node("dt", label), node("dd", value));
      $("recorder").append(row);
    }
    $("version").textContent = cfg.version;
    $("cost-note").textContent =
      cfg.strategy.feeBps +
      " bps fees per leg · " +
      cfg.strategy.slippageBps +
      " bps market slippage";
    $("updated").textContent = scan.lastScan
      ? "Last price scan " + time(scan.lastScan.finishedAt / 1000) + " UTC"
      : "Waiting for the first scan";
    const notice = $("notice");
    notice.className = "notice";
    if (!health.scanEnabled)
      notice.textContent =
        "Recorder paused. Enable scanning after configuring your price source and persistence.";
    else if (scan.stale || !health.ready) {
      notice.classList.add("error");
      notice.textContent =
        health.lastError ||
        "Recorder is waiting for complete, fresh data and persistence. Check the recording status below.";
    } else {
      notice.classList.add("good");
      notice.textContent =
        "Paper recorder active. Profitability remains unvalidated; only supported cohorts can receive quality stars.";
    }
    $("lab-status").textContent =
      lab.status === "running"
        ? "A frozen-dataset experiment is running."
        : lab.status === "failed"
          ? "Backtest failed: " + lab.error
          : lab.status === "complete"
            ? "Backtest complete · " +
              (lab.results?.kind === "synthetic"
                ? "synthetic software check only"
                : "historical research result available through the API")
            : "No backtest has run in this process.";
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    $("refresh").disabled = true;
    try {
      const [health, cfg, scan, stats, lab] = await Promise.all([
        get("/api/health"),
        get("/api/config"),
        get("/api/scan"),
        get("/api/live-stats"),
        get("/api/backtest"),
      ]);
      currentPairs = scan.data || [];
      renderPairs();
      renderTrades(scan.history || []);
      renderStats(stats);
      renderStatus(health, cfg, scan, lab);
      $("access").hidden = true;
    } catch (error) {
      $("notice").className = "notice error";
      $("notice").textContent =
        error.name === "TimeoutError"
          ? "Recorder request timed out. Displayed data may be stale."
          : error.message;
      $("updated").textContent =
        "Connection unavailable · displayed data may be stale";
    } finally {
      busy = false;
      $("refresh").disabled = false;
    }
  }
  $("refresh").addEventListener("click", refresh);
  $("pair-filter").addEventListener("change", renderPairs);
  $("access").addEventListener("submit", (event) => {
    event.preventDefault();
    token = $("read-token").value.trim();
    $("read-token").value = "";
    refresh();
  });
  renderPairs();
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 15000);
})();
