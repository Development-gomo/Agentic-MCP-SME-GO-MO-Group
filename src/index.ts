/**
 * GO MO Group MCP server (v1.3.0)
 *
 * Exposes the public gomogroup.com agent API (https://www.gomogroup.com/agent/v1/)
 * as Model Context Protocol tools over Streamable HTTP, in stateless mode
 * (a fresh McpServer + transport per request).
 *
 * Bilingual: every list tool accepts lang = "en" | "sv" | "all". English is primary;
 * items carry their Swedish alternate URL where the site has a translation.
 */
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ReadCache, fetchJson } from "./read-cache.js";

const VERSION = "1.3.0";
const API_BASE = process.env.GOMO_API_BASE ?? "https://www.gomogroup.com/agent/v1";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const API_TIMEOUT = parseInt(process.env.API_TIMEOUT_MS ?? "10000", 10);
// Shared with WordPress (GOMO_MCP_SHARED_SECRET in wp-config.php) so the plugin rate-limits each agent by
// its own IP instead of treating every MCP submission as coming from this server.
const MCP_SHARED_SECRET = process.env.GOMO_MCP_SHARED_SECRET ?? "";

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function positiveMs(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
const readCache = new ReadCache({
  apiBase: API_BASE,
  dataDir: new URL("../data/", import.meta.url),
  timeoutMs: positiveMs("API_TIMEOUT_MS", 10000),
  refreshMs: positiveMs("MCP_CACHE_REFRESH_MS", 300000),
  retryMs: positiveMs("MCP_CACHE_RETRY_MS", 60000),
  maxAgeMs: positiveMs("MCP_CACHE_MAX_AGE_MS", 7 * 86400000),
  volatileMaxAgeMs: positiveMs("MCP_CACHE_VOLATILE_MAX_AGE_MS", 48 * 3600000),
});
const apiGet = (path: string, params: Record<string, string | undefined> = {}) => readCache.get(path, params);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? (err.name === "AbortError" ? "Upstream API timed out" : err.message) : String(err);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

const lang = z.enum(["en", "sv", "all"]).optional().describe('Language filter. "en" = English items, "sv" = Swedish items, "all" (default) = both.');

// ── Tool registry (single source for the server and GET /tools) ─────────────

const TOOLS = [
  { name: "get_company", phase: 1, method: "GET /company.json", description: "GO MO Group company profile: identity, founding, size, certifications, contacts, social links, key pages (EN + SV)." },
  { name: "list_services", phase: 1, method: "GET /services.json", description: "All services with descriptions, pricing (where published) and EN/SV URLs. Filter by category or tag." },
  { name: "get_service", phase: 1, method: "GET /services/{id}.json", description: "One service by ID, e.g. 'geo', 'seo', 'pull-marketing'." },
  { name: "list_case_studies", phase: 1, method: "GET /case-studies.json", description: "Client case studies with measured results. Filter by industry, segment, service or lang." },
  { name: "get_case_study", phase: 1, method: "GET /case-studies/{id}.json", description: "One case study by ID." },
  { name: "list_team", phase: 1, method: "GET /team.json", description: "Leadership and team profiles with roles and public contact details." },
  { name: "list_offices", phase: 1, method: "GET /offices.json", description: "Office addresses (Gothenburg HQ, Stockholm, London, Pune)." },
  { name: "list_insights", phase: 1, method: "GET /insights.json", description: "Blog/insight articles (EN + SV) with date, author, summary and topic. Filter by lang, topic, since." },
  { name: "list_events", phase: 1, method: "GET /events.json", description: "Seminars and events with dates, location and registration URLs." },
  { name: "list_careers", phase: 1, method: "GET /careers.json", description: "Open roles with location and application URL." },
  { name: "get_page_index", phase: 1, method: "GET /pages.json", description: "Every public URL on gomogroup.com with type, language and its EN/SV alternate." },
  { name: "submit_contact_inquiry", phase: 2, method: "POST /contact.json", description: "Send a qualified B2B inquiry to GO MO Group. Requires explicit user consent (agent_context.user_authorized_submission = true)." },
] as const;

function buildServer(clientIp?: string): McpServer {
  const server = new McpServer({ name: "gomo-group", version: VERSION });
  const d = (name: string) => TOOLS.find((t) => t.name === name)!.description + " Inspect _meta.freshness: when fallback is true, disclose the snapshot date and do not claim current availability or pricing.";

  server.tool("get_company", d("get_company"), {}, async () => {
    try { return ok(await apiGet("company.json")); } catch (e) { return fail(e); }
  });

  server.tool("list_services", d("list_services"),
    { category: z.string().optional().describe("e.g. search, ai, outbound, web, content, paid"), tag: z.string().optional(), lang },
    async ({ category, tag, lang }) => {
      try { return ok(await apiGet("services.json", { category, tag, lang })); } catch (e) { return fail(e); }
    });

  server.tool("get_service", d("get_service"), { id: z.string().regex(/^[a-z0-9-]+$/).describe("Service ID from list_services") },
    async ({ id }) => {
      try { return ok(await apiGet(`services/${id}.json`)); } catch (e) { return fail(e); }
    });

  server.tool("list_case_studies", d("list_case_studies"),
    { industry: z.string().optional(), segment: z.enum(["enterprise", "saas-tech", "sme"]).optional(), service: z.string().optional().describe("Service ID, e.g. seo, geo, sea"), lang },
    async ({ industry, segment, service, lang }) => {
      try { return ok(await apiGet("case-studies.json", { industry, segment, service, lang })); } catch (e) { return fail(e); }
    });

  server.tool("get_case_study", d("get_case_study"), { id: z.string().regex(/^[a-z0-9-]+$/) },
    async ({ id }) => {
      try { return ok(await apiGet(`case-studies/${id}.json`)); } catch (e) { return fail(e); }
    });

  server.tool("list_team", d("list_team"), {}, async () => {
    try { return ok(await apiGet("team.json")); } catch (e) { return fail(e); }
  });

  server.tool("list_offices", d("list_offices"), {}, async () => {
    try { return ok(await apiGet("offices.json")); } catch (e) { return fail(e); }
  });

  server.tool("list_insights", d("list_insights"),
    { lang, topic: z.string().optional().describe("e.g. geo, ai, seo, b2b-marketing, leadership, company"), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date; only posts published on/after"), page: z.number().int().min(1).optional(), per_page: z.number().int().min(1).max(200).optional() },
    async ({ lang, topic, since, page, per_page }) => {
      try { return ok(await apiGet("insights.json", { lang, topic, since, page: page?.toString(), per_page: per_page?.toString() })); } catch (e) { return fail(e); }
    });

  server.tool("list_events", d("list_events"), { lang }, async ({ lang }) => {
    try { return ok(await apiGet("events.json", { lang })); } catch (e) { return fail(e); }
  });

  server.tool("list_careers", d("list_careers"), { lang }, async ({ lang }) => {
    try { return ok(await apiGet("careers.json", { lang })); } catch (e) { return fail(e); }
  });

  server.tool("get_page_index", d("get_page_index"),
    { lang, type: z.enum(["page", "service", "solution", "case", "insight", "team", "career", "event", "legal"]).optional(), page: z.number().int().min(1).optional(), per_page: z.number().int().min(1).max(200).optional() },
    async ({ lang, type, page, per_page }) => {
      try { return ok(await apiGet("pages.json", { lang, type, page: page?.toString(), per_page: per_page?.toString() })); } catch (e) { return fail(e); }
    });

  server.tool(
    "submit_contact_inquiry",
    "Send a qualified B2B inquiry to GO MO Group's commercial team. Only call this after the user has explicitly asked you to contact GO MO Group and has confirmed the details below. You MUST set agent_context.user_authorized_submission to true to confirm that consent was given. Never invent contact details.",
    {
      person: z.object({
        name: z.string().min(2).max(120),
        email: z.string().email().max(254),
        phone: z.string().max(40).optional(),
        job_title: z.string().max(120).optional(),
      }),
      company: z.object({
        name: z.string().min(1).max(160),
        website: z.string().url().max(2048).optional(),
        country: z.string().max(80).optional(),
        size: z.string().max(40).optional(),
      }),
      inquiry: z.object({
        service_interest: z.string().min(2).max(120).describe("e.g. GEO, SEO, SEA, Pull Marketing, ASBX, Generative AI"),
        project_summary: z.string().min(10).max(4000),
        budget_range: z.string().max(80).optional(),
        timeline: z.string().max(80).optional(),
        preferred_language: z.enum(["en", "sv"]).optional(),
      }),
      agent_context: z.object({
        user_authorized_submission: z.literal(true),
        agent_name: z.string().max(80).optional(),
        conversation_summary: z.string().max(2000).optional(),
      }),
    },
    async (body) => {
      try {
        const data = await fetchJson(`${API_BASE.replace(/\/+$/, "")}/contact.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "GomoGroup-Agent/1.0 (+https://www.gomogroup.com)",
            ...(MCP_SHARED_SECRET && clientIp ? { "X-GOMO-MCP-Key": MCP_SHARED_SECRET, "X-GOMO-Client-IP": clientIp } : {}),
          },
          body: JSON.stringify(body),
        }, API_TIMEOUT);
        const receipt = z.object({ status: z.enum(["received", "duplicate"]), lead_id: z.string().min(1), message: z.string() }).passthrough().safeParse(data);
        if (!receipt.success) throw new Error("Upstream returned no valid contact receipt");
        return ok(receipt.data);
      } catch (e) {
        const reason = e instanceof Error ? e.message : "Upstream unavailable";
        return fail(new Error(`Contact delivery is unconfirmed: ${reason}. No cached success was used. Do not automatically retry; contact hello@gomogroup.com if uncertain.`));
      }
    },
  );

  return server;
}

// ── HTTP app ─────────────────────────────────────────────────────────────────

const app = express();
// Behind Nginx on the same host: take the client IP from X-Forwarded-For only when the hop is local.
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "32kb" }));

// Applied to the MCP endpoint only — app.use("/mcp") would also throttle /mcp/health and /mcp/tools.
const limiter = rateLimit({ windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });

// Health and discovery live under /mcp/ so they work behind the same Nginx location.
const health = (_req: Request, res: Response) => { res.json({ status: "ok", name: "gomo-group", version: VERSION, api_base: API_BASE, reads: readCache.status(), contact: "live-only; not checked by health" }); };
const tools = (_req: Request, res: Response) => { res.json({ name: "gomo-group", version: VERSION, transport: "streamable-http", endpoint: "https://agent-mcp.gomogroup.com/mcp", tools: TOOLS }); };
app.get(["/health", "/mcp/health"], health);
app.get(["/tools", "/mcp/tools"], tools);
app.get(["/ready", "/mcp/ready"], (_req: Request, res: Response) => {
  const state = readCache.status();
  res.status(state.ready ? 200 : 503).json(state);
});

app.all("/mcp", limiter, async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(req.ip);
  res.on("finish", () => { server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal MCP server error" });
  }
});

app.listen(PORT, () => {
  console.log(`gomo-mcp ${VERSION} listening on :${PORT} (api: ${API_BASE})`);
});
