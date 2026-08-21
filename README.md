# schema-audit

[![CI](https://github.com/madahzadeh/schema-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/madahzadeh/schema-audit/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-lightgrey)](package.json)

Zero-dependency CLI that crawls your site and validates its **JSON-LD structured data** (schema.org) the way a technical-SEO consultant would: missing required properties, malformed JSON, bad dates and prices, broken breadcrumbs — with fix hints and CI-friendly exit codes. Google retired its standalone structured-data testing workflow; this gives you a scriptable one.

![schema-audit demo](docs/demo.gif)

## Quick start

Node.js 20+ is the only requirement — no `npm install` needed.

```bash
git clone https://github.com/madahzadeh/schema-audit.git
cd schema-audit

node schema-audit.mjs https://example.com/          # crawl and audit
node schema-audit.mjs --sitemap https://example.com/sitemap.xml
npm run demo                                        # offline demo with seeded issues
npm test                                            # deterministic test suite
```

## What it checks

| Code | Check | Meaning |
|---|---|---|
| S001 | invalid-json | a `ld+json` block fails to parse |
| S002 | missing-type | top-level object has no `@type` |
| S003 | missing-context | no schema.org `@context` |
| S004 | missing-required | required property absent for the entity type |
| S005 | bad-value | non-ISO dates, prices with currency symbols, relative URLs, non-integer breadcrumb positions |
| S101 | missing-recommended | recommended properties absent (richer results) |
| S102 | duplicate-entity | the same entity declared twice on one page |
| S103 | no-structured-data | page has no JSON-LD at all |
| S104 | breadcrumb-order | breadcrumb positions not sequential from 1 |

Type rules cover the common rich-result types, based on schema.org and Google's rich-results guidance: Article / NewsArticle / BlogPosting, Product (offers, price, priceCurrency logic), LocalBusiness, Organization, Person, Event, JobPosting, Recipe, FAQPage (question/answer completeness), BreadcrumbList (positions and names), WebSite, WebPage. `@graph` and nested entities are fully traversed.

## CLI options

| Option | Default | Description |
|---|---|---|
| `--sitemap <url>` | — | audit pages listed in a sitemap (sitemap-index supported) |
| `--urls <file>` | — | audit an explicit list of URLs (one per line) |
| `--max-pages <n>` | 200 | crawl limit |
| `--concurrency <n>` | 5 | parallel requests |
| `--timeout <ms>` | 10000 | per-request timeout |
| `--user-agent <ua>` | `schema-audit/1.0` | custom User-Agent |
| `--fail-on <level>` | `error` | `error` \| `warning` \| `none` — controls exit code |
| `--json` | — | machine-readable JSON report |
| `--no-color` | — | disable colored output |

Exit codes: `0` clean · `1` findings at/above `--fail-on` · `2` usage/runtime error.

## CI example

```yaml
name: structured-data
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: |
          curl -sL https://raw.githubusercontent.com/madahzadeh/schema-audit/main/schema-audit.mjs -o schema-audit.mjs
          node schema-audit.mjs https://example.com/ --max-pages 300 --no-color
```

## Limitations

Honest scope: only JSON-LD is audited — Microdata and RDFa are not parsed. HTML is read as served (no JavaScript rendering). Required/recommended property sets are an opinionated distillation of schema.org and Google's guidance, not a certification; Google's own Rich Results Test remains the final word for eligibility.

## Hire me

I build AI automation, release workflows, mobile products, and technical-SEO-driven web systems for founders and international businesses.

- Upwork: [madahzadeh.com/upwork](https://madahzadeh.com/upwork)
- Portfolio and contact: [github.com/madahzadeh](https://github.com/madahzadeh) · [iequity.co](https://iequity.co)
