const test = require("node:test");
const assert = require("node:assert/strict");
const { yahooChartSymbol, filterCandlesByRange } = require("../server.js");

test("yahooChartSymbol normalizes for Yahoo chart", () => {
  assert.equal(yahooChartSymbol(" brk.b "), "BRK-B");
  assert.equal(yahooChartSymbol("AAPL"), "AAPL");
});

test("filterCandlesByRange keeps rows in window", () => {
  const candles = {
    s: "ok",
    t: [100, 200, 300],
    o: [1, 2, 3],
    h: [1, 2, 3],
    l: [1, 2, 3],
    c: [1, 2, 3],
    v: [10, 20, 30],
  };
  const out = filterCandlesByRange(candles, 150, 250);
  assert.ok(out);
  assert.deepEqual(out.t, [200]);
});

test("filterCandlesByRange returns null when no overlap", () => {
  const candles = { s: "ok", t: [100], o: [1], h: [1], l: [1], c: [1], v: [1] };
  assert.equal(filterCandlesByRange(candles, 200, 300), null);
});
