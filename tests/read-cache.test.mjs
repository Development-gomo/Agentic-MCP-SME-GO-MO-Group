import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { ReadCache, fetchJson, validateSnapshot } from "../dist/read-cache.js";

const dataDir = new URL("../data/", import.meta.url);
const sample = name => JSON.parse(readFileSync(new URL(`${name}.json`, dataDir), "utf8"));
const NOW = Date.parse("2026-10-20T10:00:00Z");
const tick = () => new Promise(resolve => setImmediate(resolve));
const config = extra => ({ apiBase: "https://example.invalid/agent/v1/", dataDir, now: () => NOW, ...extra });

test("cold start serves validated bundled company despite blocked origin", async () => {
  let calls = 0;
  const cache = new ReadCache(config({ fetcher: async () => { calls++; throw new Error("HTML challenge"); } }));
  const response = await cache.get("company.json");
  assert.equal(response.data.name, "GO MO Group");
  assert.equal(response._meta.freshness.source, "bundled");
  assert.equal(response._meta.freshness.fallback, true);
  assert.equal(response._meta.freshness.generated_at, sample("company")._meta.generated);
  await tick();
  assert.equal((await cache.get("company.json"))._meta.freshness.upstream_error, "HTML challenge");
  assert.equal(calls, 1, "failed origin attempts are throttled");
});

test("healthy reads never wait for a stalled refresh and concurrent calls coalesce", async () => {
  let release; let calls = 0;
  const cache = new ReadCache(config({ fetcher: () => { calls++; return new Promise(resolve => { release = resolve; }); } }));
  const responses = await Promise.all(Array.from({ length: 10 }, () => cache.get("company.json")));
  assert.equal(responses.length, 10);
  assert.equal(calls, 1);
  release(sample("company"));
  await tick();
  const refreshed = await cache.get("company.json");
  assert.equal(refreshed._meta.freshness.source, "upstream");
  assert.equal(refreshed._meta.freshness.fallback, false);
});

test("failed and malformed refreshes retain last good content without renewing its age", async () => {
  let now = NOW;
  let malformed = false;
  const cache = new ReadCache(config({ now: () => now, refreshMs: 10, fetcher: async () => malformed ? { status: "ok", data: [] } : sample("company") }));
  await cache.get("company.json"); await tick();
  const original = await cache.get("company.json");
  now += 1000; malformed = true;
  await cache.get("company.json"); await tick();
  const fallback = await cache.get("company.json");
  assert.equal(fallback.data.name, original.data.name);
  assert.equal(fallback._meta.freshness.last_verified_at, original._meta.freshness.last_verified_at);
  assert.equal(fallback._meta.freshness.age_seconds, 1);
  assert.equal(fallback._meta.freshness.fallback, true);
});

test("filters and aliases work on complete bundles without cross-query contamination", async () => {
  const cache = new ReadCache(config({ fetcher: async () => { throw new Error("offline"); } }));
  const [sv, en] = await Promise.all([
    cache.get("insights.json", { lang: "sv", per_page: "5", page: "2" }),
    cache.get("insights.json", { lang: "en", topic: "geo", since: "2026-01-01" }),
  ]);
  assert.equal(sv.data.length, 5);
  assert.equal(sv.pagination.page, 2);
  assert(sv.data.every(item => item.lang === "sv"));
  assert(en.data.length > 0);
  assert(en.data.every(item => item.lang === "en" && item.topics.includes("geo") && item.datePublished >= "2026-01-01"));
  const geo = await cache.get("services/generative-engine-optimization-geo.json");
  assert.equal(geo.data.id, "geo");
  const cases = await cache.get("case-studies.json", { service: "seo" });
  assert(cases.data.length > 0 && cases.data.every(item => item.services.includes("seo")));
  const local = await cache.get("services.json", { category: "local" });
  assert(local.data.length > 0 && local.data.every(item => item.category === "local"));
  const pages = await cache.get("pages.json", { page: "2", per_page: "200" });
  assert.equal(pages.data.length, sample("pages").data.length - 200);
  const events = await cache.get("events.json", { lang: "sv" });
  assert(events.data.every(item => item.url_sv));
  geo.data.name = "mutated by caller";
  assert.notEqual((await cache.get("services/geo.json")).data.name, geo.data.name);
  await assert.rejects(cache.get("services/not-an-id.json"), /No item/);
  await assert.rejects(cache.get("contact.json"), /Unknown read endpoint/);
});

test("expired fallback is rejected, with shorter limits for careers and events", async () => {
  const now = Date.parse("2026-10-22T00:00:01Z");
  const cache = new ReadCache(config({ now: () => now, fetcher: async () => { throw new Error("offline"); } }));
  await assert.rejects(cache.get("careers.json"), /no sufficiently recent/);
  await assert.rejects(cache.get("events.json"), /no sufficiently recent/);
  assert.equal((await cache.get("company.json")).data.name, "GO MO Group");
  assert.equal(cache.status().ready, false);
  const expired = new ReadCache(config({ now: () => now + 7 * 86400000, fetcher: async () => { throw new Error("offline"); } }));
  await assert.rejects(expired.get("company.json"), /no sufficiently recent/);
});

test("expired or missing bundle can recover from a valid live response", async () => {
  const cache = new ReadCache(config({ dataDir: new URL("./missing/", dataDir), fetcher: async () => sample("company") }));
  const response = await cache.get("company.json");
  assert.equal(response.data.name, "GO MO Group");
  assert.equal(response._meta.freshness.source, "upstream");
  assert.equal(response._meta.freshness.fallback, false);
});

test("validated empty live collections replace old records", async () => {
  const empty = sample("careers");
  empty.data = [];
  empty.pagination = { total: 0, page: 1, per_page: 0, pages: 1 };
  const cache = new ReadCache(config({ fetcher: async () => empty }));
  await cache.get("careers.json"); await tick();
  assert.deepEqual((await cache.get("careers.json")).data, []);
});

test("partial, duplicate, future-dated and malformed snapshots are rejected", () => {
  const partial = sample("services");
  partial.data = partial.data.slice(0, 1);
  assert.throws(() => validateSnapshot(partial, "services", NOW), /Incomplete/);
  const duplicate = sample("services");
  duplicate.data[1] = duplicate.data[0];
  assert.throws(() => validateSnapshot(duplicate, "services", NOW), /duplicate/);
  const future = sample("company");
  future._meta.generated = "2099-01-01";
  assert.throws(() => validateSnapshot(future, "company", NOW), /generation date/);
  assert.throws(() => validateSnapshot({ status: "ok", data: {} }, "company", NOW), /envelope/);
});

test("fetch helper rejects HTML, malformed JSON, bad HTTP, slow bodies and oversized data", async t => {
  const server = createServer((req, res) => {
    if (req.url === "/html") { res.setHeader("Content-Type", "text/html"); return res.end("<html>captcha</html>"); }
    if (req.url === "/403") { res.statusCode = 403; return res.end("blocked"); }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/malformed") return res.end("{bad");
    if (req.url === "/large") return res.end(JSON.stringify("x".repeat(2 * 1024 * 1024)));
    if (req.url === "/slow") { res.flushHeaders(); return; }
    res.end('{"status":"ok"}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await fetchJson(base), { status: "ok" });
  await assert.rejects(fetchJson(base + "/html"), /non-JSON/);
  await assert.rejects(fetchJson(base + "/403"), /HTTP 403/);
  await assert.rejects(fetchJson(base + "/malformed"), /invalid JSON/);
  await assert.rejects(fetchJson(base + "/large"), /exceeds/);
  await assert.rejects(fetchJson(base + "/slow", {}, 50), /timed out/);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(fetchJson(base), /fetch failed/);
});
