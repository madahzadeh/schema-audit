import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractJsonLd, collectEntities, auditHtml, audit, startFixtureServer,
  isIsoDate, isPriceLike, normalizeUrl,
} from "../schema-audit.mjs";

/* ---------------- unit ---------------- */

test("extractJsonLd finds and parses ld+json blocks", () => {
  const html = `<script type="application/ld+json">{"@type":"Thing"}</script>
    <script>var x = 1;</script>
    <script type="application/ld+json">{bad json}</script>`;
  const blocks = extractJsonLd(html);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].parsed, { "@type": "Thing" });
  assert.equal(blocks[0].error, null);
  assert.ok(blocks[1].error);
});

test("collectEntities walks nested structures and @graph", () => {
  const doc = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Acme", founder: { "@type": "Person", name: "Reza" } },
      { "@type": ["Article", "BlogPosting"], headline: "Hi" },
    ],
  };
  const entities = collectEntities(doc);
  const types = entities.flatMap((e) => e.types);
  assert.ok(types.includes("Organization"));
  assert.ok(types.includes("Person"));
  assert.ok(types.includes("Article"));
  assert.equal(entities.length, 3);
});

test("date and price validators", () => {
  assert.ok(isIsoDate("2026-08-21"));
  assert.ok(isIsoDate("2026-08-21T09:00:00+04:00"));
  assert.ok(!isIsoDate("01/08/2026"));
  assert.ok(isPriceLike("19.99"));
  assert.ok(isPriceLike(20));
  assert.ok(!isPriceLike("$19.99"));
});

test("normalizeUrl basics", () => {
  assert.equal(normalizeUrl("HTTPS://E.com:443/x#y"), "https://e.com/x");
  assert.equal(normalizeUrl(":::"), null);
});

/* ---------------- auditHtml rules ---------------- */

const wrap = (obj) => `<html><body><script type="application/ld+json">${JSON.stringify(obj)}</script></body></html>`;
const codesOf = (r) => new Set(r.findings.map((f) => f.code));

test("valid Article produces no findings", () => {
  const r = auditHtml(wrap({
    "@context": "https://schema.org", "@type": "Article",
    headline: "H", image: "https://e.com/i.jpg", datePublished: "2026-01-01",
    author: { "@type": "Person", name: "R" },
  }), "https://e.com/");
  assert.deepEqual(r.findings, []);
  assert.equal(r.entities, 2);
});

test("missing required and recommended properties are flagged", () => {
  const r = auditHtml(wrap({ "@context": "https://schema.org", "@type": "LocalBusiness", telephone: "+374" }), "https://e.com/");
  const codes = codesOf(r);
  assert.ok(codes.has("S004")); // name + address missing
  assert.ok(codes.has("S101")); // url/openingHours recommended
});

test("Product offer rules: symbol price, missing currency, missing offers", () => {
  const r1 = auditHtml(wrap({
    "@context": "https://schema.org", "@type": "Product", name: "W",
    offers: { "@type": "Offer", price: "$19.99" },
  }), "https://e.com/");
  const codes1 = codesOf(r1);
  assert.ok(codes1.has("S005"), "symbol price");
  assert.ok(codes1.has("S004"), "missing priceCurrency");

  const r2 = auditHtml(wrap({ "@context": "https://schema.org", "@type": "Product", name: "W2" }), "https://e.com/");
  assert.ok(r2.findings.some((f) => f.code === "S004" && /offers, review, or aggregateRating/.test(f.detail)));
});

test("bad date, relative URL, missing context, missing type, invalid json, no data", () => {
  const badDate = auditHtml(wrap({ "@context": "https://schema.org", "@type": "Organization", name: "A", url: "/x", foundingDate: "x", datePublished: "01/02/2026" }), "https://e.com/");
  assert.ok(codesOf(badDate).has("S005"));

  const noCtx = auditHtml(wrap({ "@type": "Organization", name: "A" }), "https://e.com/");
  assert.ok(codesOf(noCtx).has("S003"));

  const noType = auditHtml(wrap({ "@context": "https://schema.org", name: "A" }), "https://e.com/");
  assert.ok(codesOf(noType).has("S002"));

  const badJson = auditHtml(`<script type="application/ld+json">{oops}</script>`, "https://e.com/");
  assert.ok(codesOf(badJson).has("S001"));

  const empty = auditHtml("<html><body>hi</body></html>", "https://e.com/");
  assert.ok(codesOf(empty).has("S103"));
});

test("FAQ and breadcrumb custom rules", () => {
  const faq = auditHtml(wrap({
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: [{ "@type": "Question", name: "Q1" }],
  }), "https://e.com/");
  assert.ok(faq.findings.some((f) => f.code === "S004" && /acceptedAnswer/.test(f.detail)));

  const crumbs = auditHtml(wrap({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home" },
      { "@type": "ListItem", position: 3, name: "Products" },
    ],
  }), "https://e.com/");
  assert.ok(codesOf(crumbs).has("S104"));
});

test("duplicate entities are flagged", () => {
  const html = wrap({ "@context": "https://schema.org", "@type": "Organization", name: "Acme", url: "https://e.com/" }) +
    wrap({ "@context": "https://schema.org", "@type": "Organization", name: "Acme", url: "https://e.com/" });
  const r = auditHtml(html, "https://e.com/");
  assert.ok(codesOf(r).has("S102"));
});

/* ---------------- integration ---------------- */

test("crawl audit of the fixture site produces expected findings per page", async () => {
  const { server, base } = await startFixtureServer();
  try {
    const { summary, findings } = await audit({ mode: "crawl", startUrl: `${base}/`, concurrency: 4 });
    const codesFor = (path) => new Set(findings.filter((f) => f.page === `${base}${path}`).map((f) => f.code));

    assert.deepEqual(codesFor("/"), new Set(), "home Article must be clean");
    assert.deepEqual(codesFor("/product"), new Set(["S004", "S005", "S101"]));
    assert.deepEqual(codesFor("/faq"), new Set(["S001"]));
    assert.deepEqual(codesFor("/biz"), new Set(["S004", "S005", "S101"]));
    assert.deepEqual(codesFor("/crumbs"), new Set(["S104"]));
    assert.deepEqual(codesFor("/plain"), new Set(["S103"]));

    assert.equal(summary.pagesScanned, 6);
    assert.equal(summary.pagesWithStructuredData, 5);
    assert.ok(summary.errors > 0 && summary.warnings > 0);
  } finally {
    server.close();
  }
});
