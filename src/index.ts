import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response as ExpressResponse } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

const API_BASE    = process.env.GOMO_API_BASE ?? "https://www.gomogroup.com/agent/v1";
const PORT        = parseInt(process.env.PORT ?? "3000", 10);
const API_TIMEOUT = parseInt(process.env.API_TIMEOUT_MS ?? "10000", 10);

// ── REST API helpers ─────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = API_TIMEOUT
): Promise<globalThis.Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Upstream API error ${res.status} at ${path}`);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ── MCP server factory ───────────────────────────────────────────────────────
// A new server instance is created per request (stateless HTTP transport).

function buildServer(): McpServer {
  const server = new McpServer({
    name:    "go-mo-group",
    version: "1.0.0",
  });

  // ── PHASE 1: Read-only tools ─────────────────────────────────────────────

  server.tool(
    "get_company",
    "Returns GO MO Group company identity: name, description, founding year, employee count, certifications (Google Partner, Microsoft Advertising Elite Partner, Ahrefs Agency Partner, Semrush Certified Agency Partner), office locations, social media links, and key contact details.",
    {},
    async () => ok(await apiGet("/company.json"))
  );

  server.tool(
    "list_services",
    "Returns all GO MO Group service offerings. Optionally filter by category (e.g. 'AI Search Visibility', 'Paid Search', 'Lead Generation', 'Web', 'Strategy', 'Content') or tag (e.g. 'geo', 'seo', 'b2b', 'ai-content').",
    {
      category: z.string().optional().describe("Filter by service category"),
      tag:      z.string().optional().describe("Filter by tag"),
    },
    async ({ category, tag }) => {
      const params = new URLSearchParams();
      if (category) params.set("category", category);
      if (tag)      params.set("tag", tag);
      const qs = params.toString() ? `?${params}` : "";
      return ok(await apiGet(`/services.json${qs}`));
    }
  );

  server.tool(
    "get_service",
    "Returns a single GO MO Group service by ID. Valid IDs: geo, seo, sea, pull-marketing, content-marketing, asbx, go-mo-dbs, web-development, web-design, programmatic, digital-analysis, ai-implementation.",
    {
      id: z.string().describe("Service ID"),
    },
    async ({ id }) => ok(await apiGet(`/services/${id}.json`))
  );

  server.tool(
    "list_case_studies",
    "Returns GO MO Group client case studies with results and context. Filter by industry (e.g. 'Technology', 'Manufacturing', 'Construction', 'Automotive'), segment ('B2B Enterprise', 'B2B SaaS/Tech', 'B2B SME'), or service ID (e.g. 'seo', 'geo', 'asbx', 'ai-implementation').",
    {
      industry: z.string().optional().describe("Filter by industry"),
      segment:  z.string().optional().describe("Filter by segment: 'B2B Enterprise', 'B2B SaaS/Tech', or 'B2B SME'"),
      service:  z.string().optional().describe("Filter by service ID"),
    },
    async ({ industry, segment, service }) => {
      const params = new URLSearchParams();
      if (industry) params.set("industry", industry);
      if (segment)  params.set("segment", segment);
      if (service)  params.set("service", service);
      const qs = params.toString() ? `?${params}` : "";
      return ok(await apiGet(`/case-studies.json${qs}`));
    }
  );

  server.tool(
    "get_case_study",
    "Returns a single case study by ID. Known IDs: construction-1200-romi, fortune500-seo-genai, dell-technologies-asbx, coor-facility-management.",
    {
      id: z.string().describe("Case study ID"),
    },
    async ({ id }) => ok(await apiGet(`/case-studies/${id}.json`))
  );

  server.tool(
    "list_team",
    "Returns the GO MO Group leadership team — 8 profiles with roles, email addresses, phone numbers, office locations, and LinkedIn URLs.",
    {},
    async () => ok(await apiGet("/team.json"))
  );

  server.tool(
    "list_offices",
    "Returns all GO MO Group offices — Gothenburg (HQ), Stockholm, London, and Pune — with full street addresses, contact details, and timezones.",
    {},
    async () => ok(await apiGet("/offices.json"))
  );

  // ── PHASE 2: Action tool — requires explicit user consent ────────────────

  server.tool(
    "submit_contact_inquiry",
    `Submit a qualified B2B inquiry to GO MO Group on behalf of a user.

CONSENT REQUIRED: Only call this tool after the human user has explicitly approved the submission.
You MUST set agent_context.user_authorized_submission to true to confirm that consent was given.
Never invent or guess contact or company details.
Never submit without the user's explicit permission.`,
    {
      contact_person: z.object({
        name:      z.string().describe("Full name of the contact person"),
        email:     z.string().email().describe("Business email address"),
        phone:     z.string().optional(),
        job_title: z.string().optional(),
      }),
      company: z.object({
        name:         z.string(),
        website:      z.string().url().optional(),
        country:      z.string().optional(),
        industry:     z.string().optional(),
        company_size: z.string().optional().describe("E.g. '1-50', '51-200', '201-1000', '1000+'"),
      }),
      inquiry: z.object({
        service_interest: z.enum([
          "GEO / AI Search Visibility",
          "SEO",
          "Paid Media / SEM",
          "UX / CRO",
          "Website Design & Development",
          "AI / Automation",
          "Digital Strategy",
          "Analytics & Reporting",
          "Other",
        ]).describe("Primary service of interest"),
        project_summary:          z.string().describe("Brief description of the project or need"),
        business_challenge:       z.string().optional(),
        timeline:                 z.string().optional().describe("E.g. 'ASAP', 'Q3 2026', '6 months'"),
        budget_range:             z.string().optional().describe("E.g. '5k-10k/month EUR', 'TBD'"),
        preferred_contact_method: z.enum(["email", "phone", "video_call"]).default("email"),
      }),
      agent_context: z.object({
        submitted_by:               z.string().default("AI agent"),
        agent_name:                 z.string().optional().describe("Name or version of the AI agent"),
        source:                     z.string().optional().describe("URL or context from which the inquiry originated"),
        user_authorized_submission: z.literal(true).describe("Must be true — confirms the human user has approved this submission"),
      }),
    },
    async (args) => ok(await apiPost("/contact.json", args))
  );

  return server;
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Rate limiter — 100 requests / minute / IP (Cloudflare handles edge-level; this is the backstop)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again in a minute." },
});
app.use("/mcp", limiter);

// MCP endpoint — stateless: new server + transport per request
app.all("/mcp", async (req: Request, res: ExpressResponse) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer();
  res.on("finish", () => { server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal MCP server error" });
    }
  }
});

app.get("/health", (_req: Request, res: ExpressResponse) => {
  res.json({ status: "ok", name: "go-mo-mcp", version: "1.0.0", api_base: API_BASE });
});

app.get("/tools", (_req: Request, res: ExpressResponse) => {
  res.json({
    mcp_endpoint: "/mcp",
    tools: [
      { name: "get_company",            phase: 1, method: "GET",  description: "Company identity, certifications, contact details" },
      { name: "list_services",          phase: 1, method: "GET",  description: "All services — filter by category or tag" },
      { name: "get_service",            phase: 1, method: "GET",  description: "Single service by ID" },
      { name: "list_case_studies",      phase: 1, method: "GET",  description: "Case studies — filter by industry, segment, or service" },
      { name: "get_case_study",         phase: 1, method: "GET",  description: "Single case study by ID" },
      { name: "list_team",              phase: 1, method: "GET",  description: "Leadership team profiles" },
      { name: "list_offices",           phase: 1, method: "GET",  description: "Office locations with addresses" },
      { name: "submit_contact_inquiry", phase: 2, method: "POST", description: "Submit B2B inquiry — requires user_authorized_submission: true" },
    ],
  });
});

app.listen(PORT, () => {
  console.log(`GO MO Group MCP server  →  http://localhost:${PORT}/mcp`);
  console.log(`Health check            →  http://localhost:${PORT}/health`);
  console.log(`Upstream API            →  ${API_BASE}`);
});
