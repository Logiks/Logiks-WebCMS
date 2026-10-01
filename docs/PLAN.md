# Project plan — CMS + eCommerce platform

_Last updated: 2026-09-22 · Owner: BKM (SmartinfoLogiks) · Status: Phase 1 complete (one owner confirmation open: 1e); Phase 2 built but not yet audited against its exit criteria; M2.6 (the site, one system) and its page/component builder done_

**How to read this:** Phase 1 describes what exists and what is still open (verified against the code and tests).
Phases 2–4 are a **proposed breakdown** of the four-phase, ~25-week plan agreed earlier. The phase boundaries and themes are agreed;
the milestone detail, estimates and targets below are proposals to confirm or change. Items marked **❓** need a decision from the owner
(see [Open decisions](#open-decisions)).

## 1. Goal and scope

A single-site CMS with an admin console and a public website, plus an online store, that runs as a **multi-server cluster behind one
AWS ALB** with most configuration in the database. Third-party themes must be safe to install.

**In scope:** content management, themes, media, SEO, public API, catalog, cart/checkout, orders, GST-aware tax, payments
(Razorpay/Stripe/PayU), extensibility (modules), hardening, launch tooling.
**Out of scope (for now):** multi-tenant hosting, marketplace/multi-vendor, mobile apps, a visual page builder beyond block editing,
e-invoicing/e-way-bill filing (hooks only), multi-currency accounting.

## 2. Locked decisions (details in `DECISIONS.md`)

| Area     | Decision                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Runtime  | Node.js 22, Express 5, ESM, JSDoc + `tsc --checkJs`, **no build step**                                                 |
| Data     | Knex over SQLite (dev/test), MySQL, PostgreSQL; epoch-ms BIGINT timestamps; JSON as TEXT                               |
| Cluster  | Stateless web nodes + worker nodes; Redis for bus, sessions, rate limits, cache, queues; config in DB                  |
| Frontend | Admin: Alpine.js + Bootstrap 5 (self-hosted). Public: server-rendered **LiquidJS** (sandboxed, third-party-theme safe) |
| Security | argon2id, CSRF, RBAC, encrypted secrets (AES-256-GCM + rotation), audit log, rate limits                               |
| Ops      | Migrations as a deploy step (expand/contract), `/healthz` `/readyz`, graceful drain, Prometheus, structured logs       |

## 3. Roadmap at a glance

| Phase | Theme                            | Planned weeks | Status                                                                                                                                                  |
| ----- | -------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Cluster foundation and settings  | 1–5           | **Complete** (§4); 1e awaits BKM                                                                                                                        |
| 2     | CMS and public website           | 6–12          | M2.1–M2.5 built (code + tests exist, **not audited** against their exit criteria); **M2.6 the site: one system, plus the page/component builder, done** |
| 3     | eCommerce                        | 13–20         | Not started                                                                                                                                             |
| 4     | Extensibility, hardening, launch | 21–25         | Not started                                                                                                                                             |

Each phase ends with a deployable, demonstrable increment on a **3-node cluster**, and a short retrospective that updates this document.

## 4. Phase 1 — Cluster foundation (built)

### 4.1 Delivered

- **Settings:** registry-declared, DB-backed, cluster-wide; env override (`CFG__ns__key`); optimistic locking; revision history with restore;
  encrypted secrets; live reload via bus + polling fallback; drift shown per node.
- **Auth:** users, roles, permissions, argon2id, lockout, session-fixation defence, CSRF, per-IP rate limits, change password, forgot/reset
  password (single-use hashed tokens), session list/revoke, admin sign-out-everywhere, edit your own name, invite-by-email.
- **Platform:** audit log, health/readiness, graceful shutdown for ALB, node heartbeats, job queue (BullMQ + in-process fallback) with retry and
  failed-job admin, email (queued, sealed payloads, SMTP + log transport), two-level tag-invalidated cache, Prometheus metrics, CLI.
- **Admin:** overview, settings, users, roles, audit, cluster (version rails), system (health/cache/queue), My account, forgot/reset screens.
- **Quality:** 132 tests (unit, HTTP, real SMTP, real Redis multi-node, cross-process concurrency, jsdom UI), passing on SQLite, MySQL 8.4 and PostgreSQL 16. ESLint, tsc, Prettier clean.
- **Packaging:** Dockerfile (web/worker roles, Node 24), `docker-compose.yml` (MySQL + Redis + N web + worker + nginx, verified with 3 web nodes), GitHub Actions CI (not yet run), README.

### 4.2 Closing items (all done except the 1e confirmation)

| #   | Item                                                               | Result                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | **CI pipeline** (GitHub Actions)                                   | ✅ `.github/workflows/ci.yml`: lint + typecheck + prettier, then the suite on SQLite / MySQL 8.4 / PostgreSQL 16 with a Redis service, plus a Docker build and `compose config` check. **Written but not yet run on GitHub** (there is no repository yet).                          |
| 1b  | **Run the suite on MySQL and PostgreSQL** (`TEST_DB_URL`)          | ✅ 127/127 on SQLite, MySQL 8.4 and PostgreSQL 16, each with Redis. It found one real bug: the "one reset link per minute" limit could be beaten by simultaneous requests (fixed with a row lock; regression test added).                                                           |
| 1c  | **Real-browser pass** of the admin                                 | ✅ Chromium against the compose cluster (§4.3). Found and fixed: sign-in failing on plain HTTP in production mode, `upgrade-insecure-requests` breaking assets on plain HTTP, admin overflowing sideways at 375 px, a missing favicon. **Safari and a real phone were not tested.** |
| 1d  | **Run `docker compose up --scale web=3`**                          | ✅ Works through the balancer; a settings save reaches every node with no drift; a hard-killed web node caused no failed requests and lost no sessions. Found and fixed: MySQL healthcheck passing too early (migrate failed), worker container always "unhealthy".                 |
| 1e  | Pick the **primary production DB** ❓                              | ⏳ **Proposed: MySQL 8.4** (D-023). Both engines pass everything, so this is about your infrastructure and load-test target. Confirm or change it.                                                                                                                                  |
| 1f  | Small gaps: edit own profile (name), invite-by-email for new users | ✅ Both built with tests (HTTP + jsdom) and checked in Chromium. Invitations reuse the reset-token mechanism (D-026).                                                                                                                                                               |

Other defects found while closing Phase 1, all fixed with tests: a SIGTERM during startup killed the node without draining (D-024); the CSRF cookie was `Secure`
even over plain HTTP (D-025); two UI tests raced the previous page's DOM; two System tests assumed SQLite; a failed test could leave a server hanging the whole
run (`--test-force-exit`). Node 24 is now the supported runtime (D-027).

### 4.3 Browser checklist

Done in real Chromium (via Playwright) against the 3-node compose cluster on plain HTTP: sign-in page loads with no script errors · wrong password shows
"Email or password is incorrect" · sign-in · every admin page renders · settings edit → save bar → save, then all nodes serve the new value and show no drift ·
Users → Add user → invite option (password field hides, clear error while email is off) · My account → change name (header updates) · usable at 375 px
(no horizontal page scroll on any page) · keyboard focus visible on every control type · only expected console messages.

**Not yet done in a real browser** (covered by the jsdom/HTTP tests only): lockout · forgot-password with email on and off · reset link valid/used/expired ·
secret field and history restore · users/roles CRUD and last-admin guards · System flush/retry · Cluster page with drift · **Safari** · a **real phone**
(only a 375 px viewport was emulated). Do these once email is configured against a real SMTP server.

## 5. Phase 2 — CMS and public website (proposed, weeks 6–12)

**Outcome:** an editor can build and publish a themed website; visitors get fast, cacheable, SEO-ready pages served from any node.
Demo: marketing site on a 3-node cluster, theme switched live, a page edit visible everywhere within seconds.

| Milestone                                        | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Exit criteria                                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M2.1 Content model** (wk 6–7)                  | Content types declared in a registry (fields reuse the settings field descriptors + Zod), entries with slug, status (draft / scheduled / published / archived), revisions with restore, hierarchy for pages, taxonomies (categories/tags), scheduled publish via the queue, per-type permissions, auto-generated admin list/edit screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Create Page and Post types; edit with revisions; schedule a post; permission-scoped editor role works; all audited                                                                                                              |
| **M2.2 Rich content and media** (wk 7–8)         | Editor.js blocks stored as JSON, **sanitised server-side** (`sanitize-html`), block→HTML renderer; media library with upload limits, type sniffing, EXIF strip, `sharp` variants (WebP/AVIF), alt text, storage adapter (local for one node, **S3** for clusters ❓)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | No stored XSS from crafted block JSON (test corpus); images served in responsive sizes; uploads work from any node                                                                                                              |
| **M2.3 Themes and rendering** (wk 8–10)          | LiquidJS sandbox (no filesystem/network escape, whitelisted tags/filters, render timeout and size limits), theme package format (`theme.json`, layouts, templates, sections, snippets, assets, locales), theme settings registered as `theme_<id>` namespaces, template resolution by type/slug, signed draft-preview links, hashed asset URLs, install/activate from a validated zip, a default theme                                                                                                                                                                                                                                                                                                                                                                                                                     | Malicious-template test suite passes; theme activation is cluster-wide and invalidates caches; default theme renders every content type                                                                                         |
| **M2.4 Delivery, cache and SEO** (wk 10–11)      | Public routing, **full-page cache for anonymous traffic** using `ctx.cache` tags (`content:<id>`, `type:<x>`, `menu`, `theme`), ETag/304 and CDN headers, redirects manager, 404s, `sitemap.xml`, `robots.txt`, canonical/OpenGraph/JSON-LD, menus, contact-form with spam protection and queued email                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Cached page p95 latency and throughput meet targets (§8); editing a page invalidates exactly its cached URLs on all nodes                                                                                                       |
| **M2.5 API, search, i18n groundwork** (wk 11–12) | Read-only public content API (`/api/public`, CORS from settings), search (DB-native: FTS5 / FULLTEXT / tsvector behind one interface ❓), locale-aware data model behind `features.multilingual`, editor/author role presets, admin polish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | API contract tests; search returns relevant results on all three DBs; Phase 2 demo scripted end to end                                                                                                                          |
| **M2.6 The site** (one system)                   | The public site is a **site tree** of pages, components and locales in the database, mirrored to `public/`, shown in a **theme** that is only the frame (D-035..D-044, `docs/SITE-STRUCTURE.md`). Done: storage, formats, dynamic pages (`[slug]`, `[...path]`), data through declared endpoints, the `seo` / `not_found` / `redirect` tags, blog, categories, search, contact and content pages as components, the classic template model removed, theme switching that changes only the theme, languages merged edited/shipped/theme, the Translations screen, `site/` layout, and the **Webmaster → Pages / Components** builder (compose-from-components with a code toggle, live preview over an unsaved draft, single-file HTML import, D-044). **Next:** menu manager, the Plugin Editor (`notes.txt`/`notes1.txt`) | Changing the theme changes layout, theme components, styles, scripts and wording and nothing else (tested); a save on one server reaches every server; the blog, content pages, search and contact work through components only |

Phase 2 dependencies already in place: settings registry, permissions, audit, queue, mailer, cache, cluster nodes view.

## 6. Phase 3 — eCommerce (proposed, weeks 13–20)

**Outcome:** a customer can browse, pay and receive an order; the merchant can fulfil, invoice and report — with correct Indian GST.

| Milestone                             | Scope                                                                                                                                                                                                                                                                                  | Exit criteria                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M3.1 Catalog** (wk 13–14)           | Products, variants/options, collections, attributes, media, SEO fields, inventory (SKU, stock, low-stock threshold), price lists, CSV import/export, storefront Liquid drops and theme sections                                                                                        | 10k-product import completes on the queue; catalog pages cache and invalidate by tag                                                                           |
| **M3.2 Pricing and tax** (wk 14–15)   | Money as **integer minor units** + currency (INR first), tax classes, **HSN codes**, GST rules: intra-state CGST+SGST vs inter-state IGST from seller/ship-to state, inclusive/exclusive prices, rounding rules, gapless per-financial-year invoice numbering                          | Table-driven tests for every GST scenario; invoice numbers never skip or repeat under concurrent checkouts on 3 nodes                                          |
| **M3.3 Cart and checkout** (wk 15–17) | Cart (Redis + DB persistence), **customer accounts as a separate auth realm** from admin users, address book, shipping zones/methods, coupons/promotions, order state machine, **inventory reservation**, idempotent order creation, order emails via queue                            | Concurrent buyers can't oversell; double-submit creates one order; cart survives node loss                                                                     |
| **M3.4 Payments** (wk 17–19)          | Gateway adapter interface; **Razorpay first**, then Stripe and PayU; hosted/tokenised flows only (no card data touches our servers); signature-verified webhooks processed idempotently on the queue; refunds; reconciliation job; credentials as encrypted settings with test buttons | A webhook that lands on a _different node_ than the checkout completes the order once; replayed webhooks are harmless; failed/abandoned payments release stock |
| **M3.5 Back office** (wk 19–20)       | Admin order screens, fulfilment and tracking numbers, invoices and credit notes (PDF), sales and **GST reports/exports**, abandoned-cart emails, customer account pages in the theme                                                                                                   | Scripted purchase → pay → fulfil → invoice → refund on the 3-node cluster                                                                                      |

Payment provider order and India-only vs multi-country launch are open (❓).

## 7. Phase 4 — Extensibility, hardening, launch (proposed, weeks 21–25)

| Milestone                         | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Exit criteria                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **M4.1 Module system** (wk 21–22) | **Started ahead of schedule as Applications → Plugin Manager (D-060)**: manifest (`plugin.json`) + lifecycle (install from zip or discover on disk / enable / migrate / disable / uninstall / export), extension points for routes, admin nav and permissions, namespaced migrations (`plugin_migrations`), full-trust execution (same tier as `services.script`/`dbms.query`), hot-load with no restart. **Not yet built**: settings/content-type/Liquid-tag/event extension points, a scaffolding CLI, module versioning beyond a single `version` field, and the Plugin Editor (AI-driven authoring) | The store (Phase 3) can be expressed as a module without core changes; a sample third-party module installs cleanly |
| **M4.2 Hardening** (wk 22–24)     | Security review against OWASP ASVS L2, CSP **without** `'unsafe-eval'` (`@alpinejs/csp`), admin 2FA (TOTP) and recovery codes, dependency audit/SBOM, upload scanning hook, backup/restore and DR runbook, failure drills (kill nodes, Redis outage, DB failover), load and soak tests, Grafana dashboards and alerts                                                                                                                                                                                                                                                                                   | No high/critical findings open; drills documented with recovery times; targets in §8 met                            |
| **M4.3 Launch** (wk 24–25)        | Import tools (CSV; optionally WordPress/Shopify) ❓, admin/developer/ops documentation, release process (semver, changelog, migration policy), CD pipeline with a migrations step and rolling deploy, production checklist, go-live                                                                                                                                                                                                                                                                                                                                                                     | Production deploy from a tag with zero-downtime rolling update rehearsed twice                                      |

## 8. Cross-cutting

**Targets to confirm** (proposals, to be measured on the primary DB ❓): cached public page p95 < 50 ms at the app tier; uncached page p95 < 300 ms;
settings propagation to all nodes < 2 s p99; zero failed requests during a rolling deploy at steady load; admin usable at 375 px.

**Testing:** every feature ships with tests at the level users notice it (HTTP, jsdom UI, real SMTP/Redis). Cluster behaviour is tested with
multiple nodes; cross-process where a driver is synchronous. Bug fix ⇒ failing test first. CI runs the SQLite/MySQL/PostgreSQL matrix.

**Security:** threat-model each new public surface (uploads, themes, checkout, webhooks) before building it; secrets only via encrypted settings;
audit every admin mutation; rate-limit every unauthenticated mutation.

**Operations:** each feature adds its metrics, health signal and runbook note. Migrations are additive.

**Definition of done:** code + tests + docs, `/verify` green, permissions/settings registered, audit written, no secrets in logs, migration
additive, admin copy reviewed, `CLAUDE.md` "Where we are" updated.

## 9. Risks

| Risk                                          | Impact                            | Mitigation                                                                                                              |
| --------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| MySQL/PG dialect differences                  | Late, expensive surprises         | Suite passes on both; keep the CI matrix mandatory (it has not run on GitHub yet)                                       |
| Third-party theme = code execution risk       | Site takeover                     | LiquidJS sandbox, template limits, validated packages, malicious-template test suite before themes ship                 |
| Payment/tax correctness (GST)                 | Financial and compliance exposure | Money as integers, table-driven tax tests, idempotent webhooks, reconciliation job, accountant review of invoice format |
| Overselling / double orders under concurrency | Lost revenue, trust               | Inventory reservation with row locks, idempotency keys, cross-node concurrency tests                                    |
| Shared file storage in a cluster              | Media missing on some nodes       | S3-compatible adapter as the cluster default; local disk only for single node                                           |
| Scope creep in the theme/page builder         | Phase 2 overrun                   | Block editor + sections only; visual builder is out of scope                                                            |
| Solo-developer bus factor                     | Stalls                            | This plan, `CLAUDE.md`, `DECISIONS.md`, and tests as the living spec                                                    |

## Open decisions

1. **Primary production database** — MySQL or PostgreSQL? (Drives CI order and load-test target.)
2. **Media storage** — S3 (recommended for clusters) or shared filesystem (EFS)?
3. **Search** — DB-native to start (simplest) or an external engine (Meilisearch/OpenSearch) from day one?
4. **Multilingual** — needed for launch, or later behind the feature flag?
5. **Payments** — Razorpay first as proposed? India-only at launch, or Stripe from the start?
6. **Customer sign-in** — email + password, or OTP/passwordless (common in India)?
7. **Third-party themes/modules** — will outsiders ever install them? (Sets how strict the sandbox and review process must be. Plugin Manager, D-060, is built for the owner's own/AI-generated plugins at single-operator trust — full, unsandboxed Node.js — so this decision is still open and gates whether a plugin-review process or sandbox is ever needed.)
8. **Hosting** — ECS, EKS or EC2 for the web/worker roles? Managed Redis (ElastiCache) and RDS assumed.
9. **Team and calendar** — who builds alongside, and are the week numbers realistic for that capacity?

## Change log

- 2026-10-01 — Applications → Plugin Manager built ahead of schedule (M4.1, D-060): disk/zip-sourced plugins at `plugins/<slug>/`, hot-load with no restart, full-trust execution.
- 2026-09-22 — Webmaster → Pages and Components built: compose-from-components page builder with a code toggle, a form-based component builder (props/api/template/CSS), live preview over an unsaved draft (never persisted), single-file HTML import (D-044).
- 2026-09-21 — Created. Phase 1 marked built with open items; Phases 2–4 proposed.
- 2026-09-22 — M2.6 finished as one system: classic templates and content routing removed, content pages/blog/search/contact are components reading declared endpoints, `site/defaults` + `site/themes`, locales merged from theme and site with a Translations screen (D-039..D-042).
- 2026-09-21 — M2.6 stage 1: site tree (pages + components in the DB, mirrored to `public/`), themes as the frame, `midnight` theme, D-035..D-038. Phase 2 status corrected: the modules exist, the milestones are not yet audited.
- 2026-09-21 — Phase 1 closed: CI workflow, MySQL/PostgreSQL runs, compose cluster and Chromium pass done; profile edit and invitations built; 1e (primary DB) proposed as MySQL, awaiting confirmation.
