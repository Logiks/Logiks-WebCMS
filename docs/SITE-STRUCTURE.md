# Site structure: one system

Everything a visitor sees is a **page** of the site, shown in a **theme**. Content (posts, content pages, custom types) is **data**
that components read through declared endpoints. There are no other templates and no other routing.

```
cms/site/                          ships with the code
  defaults/                        the starter site, loaded into an empty site on first start
    pages/  components/
  locales/<code>.json              the site's shipped wording. READ-ONLY: never written at runtime
  themes/<id>/                     built-in themes (installed themes live in the database)

cms/public/                        this server's mirror of the site tree (git-ignored; SITE_DIR)
  pages/                           index.html · blog/index.html · blog/[slug].html · [...path].html · 404.html
  components/                      hero.html · post-list.html · entry.html · contact-form.html
  locales/                         fr.json                    (only what editors changed: System → Translations)

a theme  (site/themes/<id>/ or installed)
  theme.json  layouts/  components/  styles/  scripts/  locales/  assets/
```

## 1. Who owns what

| Belongs to the **site** (survives a theme change) | Belongs to the **theme** (replaced by a theme change)  |
| ------------------------------------------------- | ------------------------------------------------------ |
| pages and their routing                           | layouts (the `<html>` frame a page picks by name)      |
| site components and their scoped CSS and data     | common components: header, footer, navigation          |
| the site's wording (`site/locales`, plus edits)   | the theme's wording (its `locales/`), styles, scripts  |
| content: posts, content pages, media, menus       | fonts, images, the theme's own settings (`theme_<id>`) |

Templates reach two namespaces that never mix:

```liquid
{% render "hero", heading: "Hi" %}      {# a SITE component:  components/hero.html #}
{% render "theme/header" %}             {# a THEME component: the active theme's components/header.html #}
```

`theme` is reserved, so a site component can't impersonate a theme one. `changing the theme changes only the theme`
(`test/site-pages.test.js`) asserts the guarantee, including for blog posts and content pages, which are pages too.
Components use the theme's CSS variables (`var(--accent)`, `var(--soft)`, `var(--line)`) so they take on a new theme's palette.

## 2. Pages and addresses

`pages/<path>.html`: front matter, then Liquid and HTML.

```html
---
title: About us
description: Who we are.
layout: default # a layout name in the active theme; falls back to `default` if the theme has none by that name
noindex: false # true: robots noindex, and left out of sitemap.xml
sitemap: true # false: left out of sitemap.xml
cache: true # false: never cached (search results)
limit: search # rate limit applied to visitors of this page
entry: page:about # (see below) which content this page shows
---
```

| File                    | Address                                  | Parts                                        |
| ----------------------- | ---------------------------------------- | -------------------------------------------- |
| `index.html`            | `/`                                      |                                              |
| `products/index.html`   | `/products` (`/products/index` is a 404) |                                              |
| `blog/[slug].html`      | `/blog/anything`                         | `params.slug`                                |
| `[type]/[...path].html` | `/event/launch/2026`                     | `params.type`, `params.path` (`launch/2026`) |
| `[...path].html`        | any address no other page has            | `params.path`                                |

The most specific page wins: fixed names, then `[param]`, then `[...rest]`. A part is one address segment of lowercase letters,
numbers, dashes or underscores (checked before the page runs). `pages/404.html` answers unknown addresses (status 404, framed by the theme);
without it the theme's frame shows a plain "Page not found".

**Which content a page shows** is what gives an entry its address (menus, sitemap, search results, previews, breadcrumbs):

- `entry: post` on `blog/[slug].html`: every post lives at `/blog/<slug>`.
- `entry: page` on `[...path].html`: content pages live at their own path (hierarchy included: `/company/team`).
- `entry: own` on `[type]/[...path].html`: every content type declared with its own address gets `/<type>/<path>`.
- `entry: page:about` on `about.html`: one fixed page for one entry.
- `terms: category` on `category/[slug].html`: term pages.

A content type with no page has no address, so it isn't linked, listed in the sitemap or found by search. Save-time checks make sure the
file name has the parts its `entry:` needs.

## 3. Components and data

One file: a Liquid/HTML template, its **scoped CSS**, and a JSON **meta** block with props and the **endpoints** it reads.

```html
<script type="application/json" data-cms="meta">
  {
    "title": "Post",
    "props": { "slug": { "type": "string" } },
    "api": [
      {
        "name": "post",
        "url": "/api/v1/content/post/{{ slug | url_encode }}",
        "required": true
      },
      {
        "name": "more",
        "url": "/api/v1/content/post?per_page=3&page={{ query.page | default: 1 }}"
      }
    ]
  }
</script>
<style>
  :host {
    display: block;
  } /* the wrapper; it has no box until you say so */
  h1 {
    font-size: 3rem;
  } /* scoped: cannot reach anything outside this component */
</style>
{% assign post = api.post.item %} {% seo item: post %}
<h1>{{ post.title }}</h1>
<div>{{ post.fields.body.html }}</div>
```

- **Data.** Each `api` entry becomes `api.<name>` in the template. The address may use Liquid (the component's arguments, `params`, `query`,
  `site`). It runs **in-process** against the public data layer (no HTTP), when the component renders. `required: true`: if that data
  answers 404 the whole page is a 404. Otherwise `api.<name>` is empty. At most 30 reads per page; only `/api/public/…` addresses exist.
- **Endpoints:** `content` (types), `content/<type>` (list: `per_page`, `page`, `sort`, `<taxonomy>=<slug>`, `locale`),
  `content/<type>/<path>` (one entry, with `breadcrumbs`, `children`, `alternates` for hierarchies and translations),
  `terms/<taxonomy>`, `terms/<taxonomy>/<slug>`, `menus/<name>`, `search?q=`, and `services/<slug>` — an admin-defined
  **Service** (Webmaster → Services, D-045/D-046): a query builder over one content type _or_ a table/view (any table
  except a hardcoded blocklist — `services.sql`), a raw read-only SQL query with named `:params` (also `services.sql`),
  or a full, unsandboxed Node.js script (`services.script`, the entire platform `ctx`, no isolate — same trust tier as
  shell access, by design).
  A component reaches one exactly like any other endpoint: `{"name": "featured", "url": "/api/public/services/<slug>?…"}`.
  The same answers are served over HTTP under `/api/public` when Settings → Features → Public content API is on
  (Services also needs its own Settings → Features → Services flag, since it's usable in-process independently of
  the headless HTTP surface); pages don't need either flag on to use one.
- **What comes back** is escaped when printed; only block html (`fields.<x>.html`) is trusted, because it was sanitised on save and on render.
- **Tags** any template can use:
  `{% seo title: …, description: …, image: …, type: "article", noindex: true, item: <entry> %}` (an entry fills in everything: title,
  description, image, structured data, breadcrumbs, hreflang), `{% not_found %}`, `{% redirect to: "/", status: 301 %}`. A Webmaster →
  SEO Manager rule for the live address overrides whatever this tag says (§8a).
- **Scoping.** Every selector is prefixed with the component's wrapper (`[data-c="a1b2c3d4"]`); `:host` is the wrapper itself;
  `@media`/`@supports`/`@container` are scoped inside, `@keyframes`/`@font-face` are global. The css of the components a page uses is emitted
  once into `<head>` after the theme's stylesheets.
- **Refused:** `<script>` in pages and components, `@import`, code-running css. Stylesheets, fonts and (when allowed) scripts from npm
  packages come from System → Libraries: load them on every page, or reach a file with `{{ 'pkg/path' | library_url }}` (D-054).

## 4. The starter site

Loaded from `site/defaults/` (pages and components) into an empty site tree on first start (every address is a page, so an empty tree would show nothing).
A site that already has files is never touched. `npm run cli -- site:seed --force` re-imports it.

| Page                                      | Shows                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `index.html`                              | the content page named in Settings → Site → Home page, else a banner and the latest posts |
| `blog/index.html`, `blog/[slug].html`     | post list with `?page=N`; one post (`seo item`, category links, structured data)          |
| `category/[slug].html`, `tag/…`           | the posts of a term; 404 when the term doesn't exist                                      |
| `search.html`                             | search box and results (rate limited, never cached, noindex)                              |
| `contact.html`                            | the contact form (posts to `/contact`)                                                    |
| `[type]/[...path].html`, `[...path].html` | custom content types; content pages (breadcrumbs, children, featured image)               |
| `404.html`                                | not found                                                                                 |

Delete, rewrite or add pages freely; that is the point. The home page's own address (`/home`) redirects to `/`.

## 5. Languages and locales

The words a visitor sees come from **three layers that are merged**, highest first:

1. **edited**: `locales/<code>.json` in the site tree (mirrored to `public/locales`, audited), what editors change under **System → Translations**;
2. **shipped**: `site/locales/<code>.json`, the site's own wording as delivered with the code. **Read-only**: nothing writes into `site/`;
3. **theme**: the theme's `locales/<code>.json`.

For the same key the higher layer wins, so an editor can re-word anything the code or a theme ships, the wording survives a theme change,
and removing an edit restores the shipped text. The database holds only the edits.

- `{{ 'blog.older' | t }}` or `{{ 'blog.older' | t: 'Older' }}` (the second form shows that text when no language file has the key).
- Lookup order: the visitor's language (site, then theme), its base language (`fr-CA` → `fr`), the default language, English, the fallback
  text, the key.
- A **language exists** as soon as any layer has a file for it (or Settings → Content lists it). With Settings → Features →
  Multiple languages on, `/<code>/…` is served for each; a code nobody has is just an unknown address. Templates get `site.languages`
  (`code`, `name`, `current`) for a switcher.
- **Translations screen / API** (`locales.read`, `locales.write`): for one language, every string the site or theme has, with the default
  language as reference, the theme's wording, the shipped wording and the editor's override. Saving stores **only the overrides**
  (`PUT /api/admin/site/locales/<code>` `{strings: {"blog.title": "…"}}`); an empty set removes the file, so the shipped and theme wording show through.

## 6. Where it lives (cluster)

The **database is the source of truth** (`site_files`, `site_meta.version`). Each server keeps an **in-memory snapshot** (what requests
render from) and a **mirror** of `pages/`, `components/` and `locales/` in `SITE_DIR`. A file changed by hand is kept as `<file>.local`
(save it with `site:push`). A save is one transaction (file, audit, version bump), refreshes this server, publishes on the bus and
invalidates the `sitefiles` cache tag; every server also polls the version, so a lost message heals itself. Saving with `expectedHash`
is refused (409) if someone saved in between.

```bash
npm run cli -- site:list | site:pull [dir] | site:push [dir] --prune | site:seed --force
```

Admin API: `GET /api/admin/site/files`, `GET|PUT|DELETE /api/admin/site/file?path=…` (permissions by kind: `pages.*`, `components.*`,
`locales.*`), plus the translations API above. Saving validates the whole file: path grammar, size (200 KB), front matter and
its bindings, meta, css, Liquid syntax (parsed by the sandbox engine), language files (JSON of strings).

## 7. Caching, fallbacks, security

- **Cache.** A page's tags are what it read (`content:<id>`, `type:<t>`, `term:<id>`, `media:<id>`…) plus `site`, `theme`, `menu`,
  `sitefiles` and `seo_rules`, so editing one entry refreshes exactly the pages that show it, and any edit to the site tree or an
  SEO Manager rule refreshes every page (a new page, or a new rule, can change what a given address shows). A page whose data
  changed while it rendered is not stored.
- **404s** for addresses that matched a page but had no data (`/x1` under a catch-all) are never stored, so made-up addresses can't fill the
  cache; browsers and CDNs may hold them for 30 s. Only "no page at all" shares a single cached 404.
- **Browsers and CDNs** may show the previous theme for up to the page's `max-age` (60 s) / `s-maxage` (300 s).
- **A theme that fails to render** (or has no `layouts/default.html`) doesn't take the site down: the built-in `default` theme steps in and
  the error is logged. Installing a theme compiles every layout and component and renders the default layout once.
- **Sandbox.** Same as themes: auto-escape, allow-listed tags and filters (plus `cms_api`, `seo`, `not_found`, `redirect`), render time and
  memory limits, no `include`, a page can't leave the site and theme namespaces. Raw HTML in a page is trusted like an administrator's, hence
  the separate `pages.*`/`components.*` permissions.

## 8. Webmaster → Pages and Components (D-044)

Two admin screens over the API above, so nobody edits raw files to build a page.

- **Components** (`components.read`/`write`): a form for the meta block (title, description, `props`, the `api` endpoints it
  reads) plus two text areas (template, scoped CSS) — not a raw single-file editor, since the meta block is structured data.
  A live preview renders the component alone, on a throwaway page, with every property at its declared default; there is no
  separate "try other values" panel, so editing the default is how you see something different.
- **Pages** (`pages.read`/`write`): a front-matter form (title, layout, noindex/sitemap/cache, what it shows) over an
  **address field** (typed without `pages/` or `.html` — those are only how it's stored — with `[param]`/`[...rest]` typed
  in directly; a trailing `.html` typed by habit is dropped, not doubled into a real `/page.html` address), and the body
  in one of two modes:
  - **Compose**: the page is an ordered list of component instances — add one from the library, fill in its declared props
    in a generated form, reorder or remove it. This is exactly a sequence of `{% render "name", k: v %}` lines; nothing new
    is invented in storage.
  - **Code**: the raw Liquid/HTML body, for anything the sequence above can't express. Switching _to_ code always works;
    switching _back_ to compose only succeeds when the body is still nothing but plain `{% render %}` lines with quoted,
    numeric or boolean arguments — otherwise it says so and stays in code, rather than guessing and losing something.
  - **Import**: reading a single `.html` file client-side (title/description guessed from `<title>`/`<meta description>`,
    the `<body>` becomes the page body) always lands in code mode.
- **Live preview**, both screens: `POST /api/admin/site/preview` renders the DRAFT content — unsaved, and never written to
  the database or `public/` — by laying it over the real site tree for one render and throwing the result away
  (`sitePages.render`'s `overlay`). A page not saved yet can still be previewed; dynamic address parts (`[slug]`) preview
  with a placeholder value unless one is typed in. The same validation a Save would run (`siteFiles.validate`) runs first,
  so a broken draft is reported the same way, not silently dropped.
- **Export/import** (D-048): `GET /api/admin/site/pages/export` / `.../components/export` download a `.zip` of every
  page/component (one JSON file per item — the theme-zip safety checks from D-031 apply on import: no path traversal,
  no absolute paths, no symlinks, `__MACOSX`/`.DS_Store` filtered). `POST .../import` upserts by path/slug; an optional
  "prune" flag also deletes items in the tree that aren't in the zip. Translations (§5) and Services get the same
  export/import shape.

## 8a. SEO Manager and the Page Manager SEO section (D-049)

Three tiers, lowest to highest precedence:

1. **Settings → SEO**: site-wide constants shown on every page — Twitter/X handle, Facebook App ID, default Twitter
   card, Google/Bing/Pinterest verification meta tags. (`site.og_image`, `site.noindex`, `site.robots_extra` already
   existed in the `site` namespace and are unchanged.)
2. **Page Manager's own SEO section** (`pages.write`): extends a page's front matter with `seo_image` (media id),
   `seo_type` (`website`/`article`) and `twitter_card` — the default for every URL that page/template produces, e.g.
   every blog post gets `article` unless something more specific says otherwise. Plain scalars, same convention as
   the existing `title`/`description`/`noindex`.
3. **SEO Manager** (`seo.read`/`seo.write`, its own screen under Webmaster): a rule for one **live URL**, exact
   (`/about`) or wildcard (`*` within one address segment, `**` across segments — `/blog/*`, `/docs/**`). When a rule
   matches, it overrides title/description/image/type/noindex/nofollow/canonical/twitter card outright — not just
   filling gaps — on top of the entry's own fields, the template's `{% seo %}` tag, and tier 2. It can also **add**
   custom meta tags (`name`/`property` + `content`) and extra JSON-LD blocks (a FAQPage/HowTo/Product schema for
   answer engines, or anything schema.org defines), appended to what the page already emits. An exact match always
   wins; among wildcard matches the longest literal prefix wins, then an admin-set `priority`.

Rules live in their own `seo_rules` table (never exposed through Services' table-source query mode or the DBMS
browser — blocklisted like `services`/`dbms_saved_queries`) and are loaded whole into a `cache.wrap`'d list, the same
pattern as `redirects.map()` — fine for the expected rule-count (tens to low hundreds), not indexed for thousands.
**LinkedIn has no meta tags of its own** (it reads Open Graph, always emitted); there is **no fixed "AEO" standard**
either, which is why the escape hatch is generic (meta tags + JSON-LD) rather than a field per platform.

A rule write invalidates every cached page (the `seo_rules` cache tag sits alongside `sitefiles` in every page's tag
list — the same deliberate exception to §7's narrow invalidation rule that D-038 already makes for site-tree edits),
since a pattern can start or stop matching an address without that address's own content changing.

## 8b. Which modules a page may use (D-069)

Front matter may add `uses: content, site` (module ids, or `none`) and `uses_services: team` (which Services, when
`services` is listed). A page that declares `uses` is held to it when it renders: a component on it that reads data from
a module it did not list gets nothing, and a warning in the log says what to add. A page without `uses` is unrestricted. The
theme's own components are never restricted. The page editor shows what a page needs and warns about gaps. Component `api`
URLs may start with `/api/v1/` (preferred) or the older `/api/public/`. See `docs/MODULES.md`.

## 9. Not built yet

Scripts in pages/components, plugins that ship pages and components, `POST` endpoints for components. (Built since this list was written:
the libraries manager, D-054; the theme file editor and customizer, D-052; the sitemap generator, D-053.) Everything above is reachable through the API today.
