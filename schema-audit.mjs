#!/usr/bin/env node
/**
 * schema-audit — zero-dependency CLI that crawls a site and validates its
 * JSON-LD structured data (schema.org) for the most common rich-result types.
 *
 * https://github.com/madahzadeh/schema-audit
 * License: MIT
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import process from "node:process";

export const VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function normalizeUrl(input, base) {
  try {
    const u = base ? new URL(input, base) : new URL(input);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
    return u.href;
  } catch {
    return null;
  }
}

export function isAbsoluteHttp(href) {
  return /^https?:\/\//i.test(String(href ?? "").trim());
}

export function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

export function isIsoDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:?\d{2}|Z)?)?$/.test(v.trim());
}

export function isPriceLike(v) {
  return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^\d+([.,]\d+)?$/.test(v.trim()));
}

/* ------------------------------------------------------------------ */
/* JSON-LD extraction                                                  */
/* ------------------------------------------------------------------ */

/** Extract raw JSON-LD blocks from HTML. Returns [{raw, parsed|null, error}] */
export function extractJsonLd(html) {
  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = parseAttrs(m[0].slice(0, m[0].indexOf(">") + 1));
    if (!/application\/ld\+json/i.test(attrs.type ?? "")) continue;
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      blocks.push({ raw, parsed: JSON.parse(raw), error: null });
    } catch (e) {
      blocks.push({ raw, parsed: null, error: e.message });
    }
  }
  return blocks;
}

/** Flatten a parsed JSON-LD document into entities that carry @type. */
export function collectEntities(doc) {
  const out = [];
  const visit = (node, depth, topLevel) => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, topLevel);
      return;
    }
    if (node["@graph"]) visit(node["@graph"], depth + 1, true);
    if (node["@type"] !== undefined) {
      const types = (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]])
        .filter((t) => typeof t === "string");
      out.push({ types, node, topLevel });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("@")) continue;
      visit(v, depth + 1, false);
    }
  };
  visit(doc, 0, true);
  return out;
}

export function extractAnchors(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (!a.href || a.href.startsWith("#") || /^(mailto|tel|javascript):/i.test(a.href)) continue;
    const u = normalizeUrl(a.href, base);
    if (u) out.add(u);
  }
  return [...out];
}

export function parseSitemapXml(xml) {
  const sitemaps = [];
  const urls = [];
  for (const sm of xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const loc = sm[1].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i);
    if (loc) sitemaps.push(loc[1].trim());
  }
  for (const u of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const loc = u[1].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i);
    if (loc) urls.push(loc[1].trim());
  }
  return { sitemaps, urls };
}

/* ------------------------------------------------------------------ */
/* Type rules (based on schema.org + Google rich-result guidance)      */
/* ------------------------------------------------------------------ */

const first = (v) => (Array.isArray(v) ? v[0] : v);
const has = (n, p) => n[p] !== undefined && n[p] !== null && n[p] !== "" && !(Array.isArray(n[p]) && n[p].length === 0);

export const TYPE_RULES = {
  Article:      { required: ["headline"], recommended: ["image", "datePublished", "author"] },
  NewsArticle:  { required: ["headline"], recommended: ["image", "datePublished", "author"] },
  BlogPosting:  { required: ["headline"], recommended: ["image", "datePublished", "author"] },
  Product:      { required: ["name"], recommended: ["image", "description", "brand"],
                  custom: (n, add) => {
                    if (!has(n, "offers") && !has(n, "review") && !has(n, "aggregateRating")) {
                      add("S004", `Product "${first(n.name) ?? ""}" needs at least one of offers, review, or aggregateRating`,
                        "add an offers object (price + priceCurrency), a review, or an aggregateRating");
                    }
                    const offer = first(n.offers);
                    if (offer && typeof offer === "object") {
                      if (!has(offer, "price") && !has(offer, "priceSpecification")) {
                        add("S004", `Offer for "${first(n.name) ?? "product"}" is missing price`, "add price and priceCurrency to the offer");
                      } else if (has(offer, "price") && !isPriceLike(first(offer.price))) {
                        add("S005", `Offer price "${first(offer.price)}" is not a plain number`, 'use a numeric value like "19.99" without currency symbols');
                      }
                      if (has(offer, "price") && !has(offer, "priceCurrency")) {
                        add("S004", `Offer for "${first(n.name) ?? "product"}" is missing priceCurrency`, 'add priceCurrency (ISO 4217, e.g. "USD")');
                      }
                    }
                  } },
  LocalBusiness: { required: ["name", "address"], recommended: ["telephone", "url", "openingHours"] },
  Organization:  { required: ["name"], recommended: ["url", "logo"] },
  Person:        { required: ["name"], recommended: [] },
  Event:         { required: ["name", "startDate", "location"], recommended: ["endDate", "image", "description", "offers"] },
  JobPosting:    { required: ["title", "hiringOrganization", "jobLocation", "datePosted"], recommended: ["validThrough", "baseSalary"] },
  Recipe:        { required: ["name"], recommended: ["image", "recipeIngredient", "recipeInstructions"] },
  FAQPage:       { required: ["mainEntity"], recommended: [],
                  custom: (n, add) => {
                    const items = Array.isArray(n.mainEntity) ? n.mainEntity : (n.mainEntity ? [n.mainEntity] : []);
                    items.forEach((q, i) => {
                      if (!q || typeof q !== "object") return;
                      if (!has(q, "name")) add("S004", `FAQ question #${i + 1} is missing name (the question text)`, "add the question text as name");
                      const ans = first(q.acceptedAnswer);
                      if (!ans || typeof ans !== "object" || !has(ans, "text")) {
                        add("S004", `FAQ question #${i + 1} is missing acceptedAnswer.text`, "add an acceptedAnswer object with the answer text");
                      }
                    });
                  } },
  BreadcrumbList: { required: ["itemListElement"], recommended: [],
                  custom: (n, add) => {
                    const items = Array.isArray(n.itemListElement) ? n.itemListElement : [];
                    const positions = [];
                    items.forEach((it, i) => {
                      if (!it || typeof it !== "object") return;
                      if (it.position === undefined) {
                        add("S004", `breadcrumb item #${i + 1} is missing position`, "add a 1-based integer position to every ListItem");
                      } else if (!Number.isInteger(Number(it.position))) {
                        add("S005", `breadcrumb position "${it.position}" is not an integer`, "use 1-based integer positions");
                      } else {
                        positions.push(Number(it.position));
                      }
                      if (!has(it, "name") && !(it.item && typeof it.item === "object" && has(it.item, "name"))) {
                        add("S004", `breadcrumb item #${i + 1} is missing name`, "add a name to the ListItem or its item");
                      }
                    });
                    const sorted = [...positions].sort((a, b) => a - b);
                    const sequential = sorted.every((p, i) => p === i + 1);
                    if (positions.length > 0 && !sequential) {
                      add("S104", `breadcrumb positions [${positions.join(", ")}] are not sequential from 1`, "number positions 1, 2, 3, … without gaps");
                    }
                  } },
  WebSite:      { required: [], recommended: ["name", "url"] },
  WebPage:      { required: [], recommended: ["name"] },
};

const DATE_PROPS = ["datePublished", "dateModified", "startDate", "endDate", "datePosted", "validThrough"];
const URL_PROPS = ["url", "image", "logo", "sameAs"];

/* ------------------------------------------------------------------ */
/* Audit engine                                                        */
/* ------------------------------------------------------------------ */

const CHECKS = {
  S001: { name: "invalid-json", severity: "error" },
  S002: { name: "missing-type", severity: "error" },
  S003: { name: "missing-context", severity: "error" },
  S004: { name: "missing-required", severity: "error" },
  S005: { name: "bad-value", severity: "error" },
  S101: { name: "missing-recommended", severity: "warning" },
  S102: { name: "duplicate-entity", severity: "warning" },
  S103: { name: "no-structured-data", severity: "warning" },
  S104: { name: "breadcrumb-order", severity: "warning" },
};

export function auditHtml(html, pageUrl) {
  const findings = [];
  const add = (code, detail, hint) =>
    findings.push({ code, check: CHECKS[code].name, severity: CHECKS[code].severity, page: pageUrl, detail, hint });

  const blocks = extractJsonLd(html);
  if (blocks.length === 0) {
    add("S103", "no JSON-LD structured data found on this page",
      'add a <script type="application/ld+json"> block describing the page');
    return { findings, entities: 0, blocks: 0 };
  }

  let entityCount = 0;
  const seen = new Map();
  for (const block of blocks) {
    if (block.error) {
      add("S001", `JSON-LD block does not parse: ${block.error}`, "fix the JSON syntax (trailing commas and comments are not allowed)");
      continue;
    }
    const docs = Array.isArray(block.parsed) ? block.parsed : [block.parsed];
    for (const doc of docs) {
      if (doc && typeof doc === "object" && !Array.isArray(doc)) {
        const ctx = JSON.stringify(doc["@context"] ?? "");
        if (!ctx || !/schema\.org/i.test(ctx)) {
          add("S003", "top-level JSON-LD object has no schema.org @context", 'add "@context": "https://schema.org"');
        }
        if (doc["@type"] === undefined && !doc["@graph"]) {
          add("S002", "top-level JSON-LD object has no @type", "add an @type (e.g. Article, Product, LocalBusiness)");
        }
      }
    }
    const entities = collectEntities(block.parsed);
    entityCount += entities.length;

    for (const { types, node } of entities) {
      const label = `${types.join("/")}${node.name ? ` "${first(node.name)}"` : node.headline ? ` "${first(node.headline)}"` : ""}`;
      // duplicates
      const key = `${types.join(",")}|${first(node.name) ?? first(node.headline) ?? first(node.url) ?? ""}`;
      if (key.split("|")[1]) {
        if (seen.has(key)) add("S102", `duplicate entity ${label} appears more than once on this page`, "keep a single canonical entity per page");
        seen.set(key, true);
      }
      // generic value checks
      for (const p of DATE_PROPS) {
        if (has(node, p) && !isIsoDate(String(first(node[p])))) {
          add("S005", `${label}: ${p}="${first(node[p])}" is not ISO 8601`, `use an ISO 8601 date like "2026-08-21" or "2026-08-21T09:00:00+04:00"`);
        }
      }
      for (const p of URL_PROPS) {
        if (!has(node, p)) continue;
        const vals = Array.isArray(node[p]) ? node[p] : [node[p]];
        for (const v of vals) {
          if (typeof v === "string" && v.trim() !== "" && !isAbsoluteHttp(v)) {
            add("S005", `${label}: ${p}="${v}" is not an absolute URL`, "use a full https:// URL");
          }
        }
      }
      // type-specific rules
      for (const t of types) {
        const rule = TYPE_RULES[t];
        if (!rule) continue;
        for (const req of rule.required) {
          if (!has(node, req)) add("S004", `${label} is missing required property "${req}"`, `add "${req}" — required for ${t} rich results`);
        }
        const missingRec = rule.recommended.filter((r) => !has(node, r));
        if (missingRec.length > 0) {
          add("S101", `${label} is missing recommended ${missingRec.length > 1 ? "properties" : "property"} ${missingRec.map((r) => `"${r}"`).join(", ")}`,
            `recommended for richer ${t} results`);
        }
        if (rule.custom) rule.custom(node, add);
      }
    }
  }
  return { findings, entities: entityCount, blocks: blocks.length };
}

async function fetchPage(url, opts) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeout),
      headers: { "user-agent": opts.userAgent, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.status >= 400 || !/html/i.test(ct)) return { url, status: res.status, skipped: true };
    const html = await res.text();
    return { url: normalizeUrl(res.url) ?? url, status: res.status, html };
  } catch (e) {
    return { url, status: 0, fetchError: e?.message ?? String(e) };
  }
}

async function pool(items, worker, size) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, size) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  }));
  return results;
}

export async function audit(options) {
  const opts = {
    mode: "crawl", startUrl: null, sitemapUrl: null, urlList: null,
    maxPages: 200, concurrency: 5, timeout: 10_000,
    userAgent: `schema-audit/${VERSION} (+https://github.com/madahzadeh/schema-audit)`,
    ...options,
  };
  let urls = [];
  if (opts.mode === "sitemap") {
    const seen = new Set();
    const queue = [opts.sitemapUrl];
    while (queue.length && seen.size < 50) {
      const smUrl = queue.shift();
      if (seen.has(smUrl)) continue;
      seen.add(smUrl);
      const res = await fetch(smUrl, { signal: AbortSignal.timeout(opts.timeout), headers: { "user-agent": opts.userAgent } });
      if (res.status >= 400) throw new Error(`failed to fetch sitemap ${smUrl}: HTTP ${res.status}`);
      const parsed = parseSitemapXml(await res.text());
      queue.push(...parsed.sitemaps);
      urls.push(...parsed.urls.map((u) => normalizeUrl(u)).filter(Boolean));
    }
    urls = [...new Set(urls)].slice(0, opts.maxPages);
  } else if (opts.mode === "urls") {
    urls = opts.urlList.map((u) => normalizeUrl(u)).filter(Boolean).slice(0, opts.maxPages);
  }

  const findings = [];
  let pagesScanned = 0;
  let pagesWithData = 0;
  let totalEntities = 0;

  const handlePage = (page) => {
    if (page.skipped || page.fetchError || !page.html) return;
    pagesScanned += 1;
    const r = auditHtml(page.html, page.url);
    findings.push(...r.findings);
    if (r.blocks > 0) pagesWithData += 1;
    totalEntities += r.entities;
    return r;
  };

  if (opts.mode === "crawl") {
    const start = normalizeUrl(opts.startUrl);
    if (!start) throw new Error("invalid start URL");
    const origin = new URL(start).origin;
    const visited = new Set();
    const queued = new Set([start]);
    let queue = [start];
    while (queue.length && visited.size < opts.maxPages) {
      const batch = queue.splice(0, opts.concurrency).filter((u) => !visited.has(u)).slice(0, opts.maxPages - visited.size);
      const results = await pool(batch, (u) => fetchPage(u, opts), opts.concurrency);
      for (const page of results) {
        visited.add(normalizeUrl(page.url) ?? page.url);
        handlePage(page);
        if (page.html) {
          for (const link of extractAnchors(page.html, page.url)) {
            if (new URL(link).origin === origin && !queued.has(link) && queued.size < opts.maxPages * 4) {
              queued.add(link);
              queue.push(link);
            }
          }
        }
      }
    }
  } else {
    const results = await pool(urls, (u) => fetchPage(u, opts), opts.concurrency);
    for (const page of results) handlePage(page);
  }

  const summary = {
    version: VERSION,
    mode: opts.mode,
    pagesScanned,
    pagesWithStructuredData: pagesWithData,
    entities: totalEntities,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
  return { summary, findings };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const useColor = () => process.stdout.isTTY && !process.argv.includes("--no-color") && !process.env.NO_COLOR;
const paint = (c, s) => (useColor() ? `\x1b[${c}m${s}\x1b[0m` : s);
const red = (s) => paint(31, s); const yellow = (s) => paint(33, s);
const green = (s) => paint(32, s); const bold = (s) => paint(1, s); const dim = (s) => paint(2, s);

export function formatReport({ summary, findings }) {
  const lines = [bold(`schema-audit v${summary.version}`), ""];
  const grouped = new Map();
  for (const f of findings) {
    if (!grouped.has(f.code)) grouped.set(f.code, []);
    grouped.get(f.code).push(f);
  }
  for (const code of Object.keys(CHECKS)) {
    const list = grouped.get(code);
    if (!list) continue;
    const color = CHECKS[code].severity === "error" ? red : yellow;
    lines.push(color(bold(`${code} ${CHECKS[code].name} (${list.length})`)));
    for (const f of list) {
      lines.push(`  ${color("•")} ${f.page}`);
      lines.push(`    ${f.detail}`);
      lines.push(dim(`    fix: ${f.hint}`));
    }
    lines.push("");
  }
  if (findings.length === 0) lines.push(green("✓ No structured-data issues found."), "");
  lines.push(bold("Summary"));
  lines.push(`  pages scanned: ${summary.pagesScanned}   pages with JSON-LD: ${summary.pagesWithStructuredData}   entities: ${summary.entities}`);
  lines.push(`  ${red(`errors: ${summary.errors}`)}   ${yellow(`warnings: ${summary.warnings}`)}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Demo fixture                                                        */
/* ------------------------------------------------------------------ */

export function startFixtureServer() {
  const page = (title, body) =>
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
  const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const routes = {
      "/": page("Home", ld({
        "@context": "https://schema.org", "@type": "Article",
        headline: "How we audit structured data",
        image: `${base}/cover.jpg`, datePublished: "2026-08-01",
        author: { "@type": "Person", name: "Reza M." },
      }) + `<a href="/product">p</a> <a href="/faq">f</a> <a href="/biz">b</a> <a href="/crumbs">c</a> <a href="/plain">n</a>`),
      "/product": page("Product", ld({
        "@context": "https://schema.org", "@type": "Product",
        name: "Acme Widget",
        offers: { "@type": "Offer", price: "$19.99" },
      })),
      "/faq": page("FAQ", `<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is it?"},]}</script>`),
      "/biz": page("Business", ld({
        "@context": "https://schema.org", "@type": "LocalBusiness",
        name: "Acme Yerevan", datePublished: "01/08/2026", url: "/contact",
      })),
      "/crumbs": page("Crumbs", ld({
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home" },
          { "@type": "ListItem", position: 3, name: "Products" },
        ],
      })),
      "/plain": page("Plain", "<p>No structured data here.</p>"),
    };
    const path = new URL(req.url, base).pathname;
    if (routes[path]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(routes[path]);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `schema-audit v${VERSION} — crawl a site and validate its JSON-LD structured data

Usage:
  schema-audit <start-url> [options]        crawl a site and audit JSON-LD
  schema-audit --sitemap <sitemap-url>      audit the pages listed in a sitemap
  schema-audit --urls <file>                audit an explicit list of URLs (one per line)
  schema-audit --demo                       offline demo against a built-in fixture site

Options:
  --max-pages <n>      max pages (default 200)
  --concurrency <n>    parallel requests (default 5)
  --timeout <ms>       per-request timeout (default 10000)
  --user-agent <ua>    custom User-Agent header
  --fail-on <level>    error | warning | none (default error)
  --json               machine-readable JSON report
  --no-color           disable colored output

Exit codes: 0 clean · 1 findings at/above --fail-on · 2 usage/runtime error`;

function parseCliArgs(argv) {
  const o = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (argv[i] === undefined) throw new Error(`missing value for ${a}`); return argv[i]; };
    switch (a) {
      case "--sitemap": o.sitemapUrl = next(); break;
      case "--urls": o.urlsFile = next(); break;
      case "--max-pages": o.maxPages = Number(next()); break;
      case "--concurrency": o.concurrency = Number(next()); break;
      case "--timeout": o.timeout = Number(next()); break;
      case "--user-agent": o.userAgent = next(); break;
      case "--fail-on": o.failOn = next(); break;
      case "--json": o.json = true; break;
      case "--no-color": break;
      case "--demo": o.demo = true; break;
      case "--help": case "-h": o.help = true; break;
      case "--version": case "-v": o.showVersion = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        o.positional.push(a);
    }
  }
  return o;
}

async function main() {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (cli.help) { console.log(USAGE); process.exit(0); }
  if (cli.showVersion) { console.log(VERSION); process.exit(0); }
  const failOn = cli.failOn ?? "error";
  if (!["error", "warning", "none"].includes(failOn)) {
    console.error("error: --fail-on must be error, warning, or none");
    process.exit(2);
  }

  let options;
  let demoServer = null;
  if (cli.demo) {
    const { server, base } = await startFixtureServer();
    demoServer = server;
    console.error(dim(`demo: auditing built-in fixture site at ${base} (works offline)\n`));
    options = { mode: "crawl", startUrl: `${base}/` };
  } else if (cli.sitemapUrl) {
    options = { mode: "sitemap", sitemapUrl: cli.sitemapUrl };
  } else if (cli.urlsFile) {
    const list = readFileSync(cli.urlsFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
    options = { mode: "urls", urlList: list };
  } else if (cli.positional.length === 1) {
    options = { mode: "crawl", startUrl: cli.positional[0] };
  } else {
    console.error(USAGE);
    process.exit(2);
  }
  for (const k of ["maxPages", "concurrency", "timeout", "userAgent"]) {
    if (cli[k] !== undefined) options[k] = cli[k];
  }

  let report;
  try {
    report = await audit(options);
  } catch (e) {
    console.error(`error: ${e.message}`);
    if (demoServer) demoServer.close();
    process.exit(2);
  }
  if (demoServer) demoServer.close();

  if (cli.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));

  if (cli.demo || failOn === "none") process.exit(0);
  const { errors, warnings } = report.summary;
  const failing = failOn === "warning" ? errors + warnings : errors;
  process.exit(failing > 0 ? 1 : 0);
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) main();
