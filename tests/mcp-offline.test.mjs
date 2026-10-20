import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("MCP cold start works behind HTML challenges; contacts never use fallback success", async t => {
  let mode = "html"; let posts = 0;
  const origin = createServer((req, res) => {
    if (req.method === "POST") posts++;
    if (mode === "html") {
      res.setHeader("Content-Type", "text/html");
      return res.end("<html><head>Hosting challenge</head></html>");
    }
    res.setHeader("Content-Type", "application/json");
    res.end(mode === "receipt" ? '{"status":"received","lead_id":"test-receipt","message":"Mock delivery only"}' : '{}');
  });
  await new Promise(resolve => origin.listen(0, "127.0.0.1", resolve));
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), GOMO_API_BASE: `http://127.0.0.1:${origin.address().port}`,
      API_TIMEOUT_MS: "300", MCP_CACHE_RETRY_MS: "60000",
      // Integration fixtures remain deterministic as real time advances. Expiry policy is tested separately with a fake clock.
      MCP_CACHE_MAX_AGE_MS: "3153600000000", MCP_CACHE_VOLATILE_MAX_AGE_MS: "3153600000000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP failed to start: ${logs}`)), 10000);
    child.stdout.on("data", data => { if (data.toString().includes("listening")) { clearTimeout(timer); resolve(); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`MCP exited: ${logs}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(name, args = {}) {
    const response = await fetch(`${base}/mcp`, { method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const text = await response.text();
    const event = text.split("\n").find(line => line.startsWith("data: "));
    assert(event, text);
    return JSON.parse(event.slice(6)).result;
  }
  for (const name of ["get_company", "list_services", "list_offices", "list_team", "list_case_studies", "list_insights", "list_events", "list_careers", "get_page_index"]) {
    const result = await call(name);
    assert(!result.isError, JSON.stringify(result));
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, "ok");
    assert.equal(body._meta.freshness.source, "bundled");
    assert.equal(body._meta.freshness.fallback, true);
  }
  const page = JSON.parse((await call("get_page_index", { page: 2, per_page: 200 })).content[0].text);
  assert.equal(page.pagination.page, 2);
  assert(page.data.length > 0);
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  const body = { person: { name: "Test User", email: "test@example.com" }, company: { name: "Test Company" },
    inquiry: { service_interest: "GEO", project_summary: "Local regression test only." },
    agent_context: { user_authorized_submission: true } };
  const blocked = await call("submit_contact_inquiry", body);
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /unconfirmed.*non-JSON/);
  mode = "invalid";
  const invalid = await call("submit_contact_inquiry", body);
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /no valid contact receipt/);
  mode = "receipt";
  const success = await call("submit_contact_inquiry", body);
  assert(!success.isError);
  assert.equal(JSON.parse(success.content[0].text).lead_id, "test-receipt");
  assert.equal(posts, 3, "each contact makes one real request to the local fixture; never cached or retried");
});
