import { readFileSync } from "node:fs";
import { z } from "zod";
export const COLLECTIONS = ["company", "services", "case-studies", "team", "offices", "insights", "events", "careers", "pages"];
const row = z.object({
    id: z.string().optional(), aliases: z.array(z.string()).optional(), languages: z.array(z.string()).nullable().optional(),
    lang: z.string().optional(), url: z.string().nullable().optional(), url_sv: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(), topics: z.array(z.string()).optional(), services: z.array(z.string()).optional(),
}).passthrough();
const envelope = z.object({
    status: z.literal("ok"),
    data: z.union([row, z.array(row)]),
    _meta: z.object({ generated: z.string() }).passthrough(),
    pagination: z.object({ total: z.number().int().nonnegative(), page: z.number().int().positive(),
        per_page: z.number().int().nonnegative(), pages: z.number().int().nonnegative() }).optional(),
});
/** Includes the body read in the timeout, rejects HTML, and bounds response memory. Never logs bodies. */
export async function fetchJson(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Upstream HTTP ${response.status}`);
        }
        const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (type !== "application/json" && !/^application\/[\w.+-]+\+json$/.test(type)) {
            await response.body?.cancel();
            throw new Error("Upstream returned non-JSON content; a hosting challenge or routing error may be blocking the API");
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error("Upstream returned an empty response");
        const chunks = [];
        let bytes = 0;
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            bytes += part.value.byteLength;
            if (bytes > 2 * 1024 * 1024) {
                await reader.cancel();
                throw new Error("Upstream JSON exceeds 2 MiB");
            }
            chunks.push(part.value);
        }
        try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        }
        catch {
            throw new Error("Upstream returned invalid JSON");
        }
    }
    catch (error) {
        if (controller.signal.aborted)
            throw new Error("Upstream API timed out");
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
export function validateSnapshot(value, collection, now) {
    const parsed = envelope.safeParse(value);
    if (!parsed.success)
        throw new Error(`Invalid ${collection} snapshot envelope`);
    const body = parsed.data;
    const generated = Date.parse(body._meta.generated);
    if (!Number.isFinite(generated) || generated > now + 300000)
        throw new Error(`Invalid ${collection} generation date`);
    if (collection === "company") {
        if (Array.isArray(body.data) || typeof body.data.name !== "string" || !body.data.name.trim()) {
            throw new Error("Invalid company snapshot");
        }
    }
    else {
        if (!Array.isArray(body.data))
            throw new Error(`Invalid ${collection} collection`);
        const key = collection === "pages" ? "url" : "id";
        const ids = new Set();
        for (const item of body.data) {
            if (typeof item[key] !== "string" || !item[key] || ids.has(item[key]))
                throw new Error(`Missing or duplicate ${collection} identifiers`);
            ids.add(item[key]);
            if (collection === "insights" || collection === "pages") {
                if (!["en", "sv"].includes(String(item.lang)) || typeof item.url !== "string")
                    throw new Error(`Invalid ${collection} language or URL`);
            }
        }
        // Cache only complete unfiltered collections; never mistake one upstream page for the whole dataset.
        if (body.pagination && (body.pagination.total !== body.data.length || body.pagination.page !== 1 || body.pagination.pages > 1)) {
            throw new Error(`Incomplete ${collection} snapshot`);
        }
        if (body._meta.filters && Object.keys(body._meta.filters).length)
            throw new Error(`Filtered ${collection} snapshot`);
    }
    return body;
}
export class ReadCache {
    config;
    entries = new Map();
    pending = new Map();
    attempts = new Map();
    errors = new Map();
    constructor(config) {
        this.config = config;
        for (const name of COLLECTIONS) {
            try {
                const body = validateSnapshot(JSON.parse(readFileSync(new URL(`${name}.json`, config.dataDir), "utf8")), name, this.now());
                const generatedAt = Date.parse(body._meta.generated);
                this.entries.set(name, { body, origin: "bundled", verifiedAt: generatedAt, generatedAt });
            }
            catch {
                this.errors.set(name, "Bundled snapshot missing or invalid");
            }
        }
    }
    now() { return (this.config.now ?? Date.now)(); }
    limit(name) {
        return ["events", "careers"].includes(name) ? (this.config.volatileMaxAgeMs ?? 48 * 3600000) : (this.config.maxAgeMs ?? 7 * 86400000);
    }
    usable(name, entry) { return !!entry && this.now() - entry.verifiedAt <= this.limit(name); }
    refresh(name) {
        const pending = this.pending.get(name);
        if (pending)
            return pending;
        const entry = this.entries.get(name);
        const last = this.attempts.get(name);
        const delay = this.errors.has(name) ? (this.config.retryMs ?? 60000) : (this.config.refreshMs ?? 300000);
        if (last !== undefined && this.now() - last < delay && (!entry || this.now() - entry.verifiedAt <= this.limit(name) || this.errors.has(name))) {
            return Promise.resolve();
        }
        this.attempts.set(name, this.now());
        const work = (async () => {
            try {
                const url = `${this.config.apiBase.replace(/\/+$/, "")}/${name}.json`;
                const value = await (this.config.fetcher ? this.config.fetcher(url) : fetchJson(url, { headers: { Accept: "application/json", "User-Agent": "GomoGroup-Agent/1.0 (+https://www.gomogroup.com)" } }, this.config.timeoutMs));
                const body = validateSnapshot(value, name, this.now());
                this.entries.set(name, { body, origin: "upstream", verifiedAt: this.now(), generatedAt: Date.parse(body._meta.generated) });
                this.errors.delete(name);
            }
            catch (error) {
                // Retain only the last known-good snapshot; failure never extends its age.
                this.errors.set(name, error instanceof Error ? error.message : "Upstream unavailable");
            }
        })().finally(() => this.pending.delete(name));
        this.pending.set(name, work);
        return work;
    }
    async get(path, params = {}) {
        const match = /^([a-z-]+)(?:\/([a-z0-9-]+))?\.json$/.exec(path);
        if (!match || !COLLECTIONS.includes(match[1]))
            throw new Error("Unknown read endpoint");
        const name = match[1];
        const id = match[2];
        let entry = this.entries.get(name);
        if (this.usable(name, entry)) {
            void this.refresh(name);
        }
        else {
            await this.refresh(name);
            entry = this.entries.get(name);
        }
        if (!this.usable(name, entry) || !entry) {
            throw new Error(`${name} unavailable: no sufficiently recent validated snapshot. ${this.errors.get(name) ?? "Refresh required"}`);
        }
        // Filter full collections locally: queries never share mutable or incorrectly keyed response caches.
        const result = structuredClone(entry.body);
        const filters = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== "" && value !== "all"));
        if (Array.isArray(result.data)) {
            if (id) {
                if (!["services", "case-studies", "insights"].includes(name))
                    throw new Error("Unsupported item lookup");
                const item = result.data.find(item => item.id === id || (Array.isArray(item.aliases) && item.aliases.includes(id)));
                if (!item)
                    throw new Error(`No item '${id}' in ${name}`);
                result.data = item;
                delete result.pagination;
            }
            else if (Object.keys(filters).length) {
                const lc = (v) => String(v ?? "").toLowerCase();
                result.data = result.data.filter(item => {
                    if (filters.lang) {
                        const languages = Array.isArray(item.languages) ? item.languages : item.lang ? [item.lang] :
                            [item.url ? "en" : null, item.url_sv ? "sv" : null];
                        if (!languages.includes(lc(filters.lang)))
                            return false;
                    }
                    for (const key of ["category", "type", "segment"])
                        if (filters[key] && lc(item[key]) !== lc(filters[key]))
                            return false;
                    if (filters.industry && !lc(item.industry).includes(lc(filters.industry)))
                        return false;
                    for (const [key, field] of [["tag", "tags"], ["service", "services"], ["topic", "topics"]]) {
                        if (filters[key] && (!Array.isArray(item[field]) || !item[field].map(lc).includes(lc(filters[key]))))
                            return false;
                    }
                    return !filters.since || String(item.datePublished ?? "") >= filters.since;
                });
                const total = result.data.length;
                const integer = (v, fallback) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback;
                const perPage = Math.max(1, Math.min(200, integer(filters.per_page, 200)));
                const page = Math.max(1, integer(filters.page, 1));
                result.data = result.data.slice((page - 1) * perPage, page * perPage);
                result.pagination = { total, page, per_page: perPage, pages: Math.ceil(total / perPage) };
            }
        }
        const age = Math.max(0, this.now() - entry.verifiedAt);
        const fallback = entry.origin === "bundled" || this.errors.has(name) || age > (this.config.refreshMs ?? 300000);
        result._meta = { ...result._meta, source: `${this.config.apiBase.replace(/\/+$/, "")}/${path}`, filters,
            freshness: {
                source: entry.origin, fallback, stale: fallback, generated_at: result._meta.generated,
                last_verified_at: entry.origin === "upstream" ? new Date(entry.verifiedAt).toISOString() : null,
                age_seconds: Math.floor(age / 1000), source_age_seconds: Math.max(0, Math.floor((this.now() - entry.generatedAt) / 1000)),
                max_age_seconds: this.limit(name) / 1000,
                warning: fallback ? "Cached snapshot; current availability, prices and roles have not been reverified. Cite the source and its date." : null,
                upstream_error: this.errors.get(name) ?? null,
            } };
        return result;
    }
    status() {
        const collections = Object.fromEntries(COLLECTIONS.map(name => {
            const entry = this.entries.get(name);
            return [name, { available: this.usable(name, entry), source: entry?.origin ?? null,
                    generated_at: entry?.body._meta.generated ?? null, last_verified_at: entry?.origin === "upstream" ? new Date(entry.verifiedAt).toISOString() : null,
                    upstream_error: this.errors.get(name) ?? null }];
        }));
        return { ready: Object.values(collections).every(value => value.available), collections };
    }
}
