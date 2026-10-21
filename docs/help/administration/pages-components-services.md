---
section: administration
title: Pages, components and services
summary: Build and change the public site from the Webmaster menu, without touching files.
order: 30
---

# Pages, components and services

The **Webmaster** menu is where the site's structure lives. For the language and code itself, see the [Coding guide](../coding/overview.md).

## The idea

- A **page** is an address on the site (`/`, `/about`, `/blog/hello`).
- A page is made of **components**: hero, card list, contact form, footer strip.
- A component can show **data**: posts, a menu, search results, or the answer of a **Service**.
- The **theme** wraps every page with the header, footer and styles.

Because a component is reusable, change it once and every page using it changes.

## Site pages

**Webmaster → Site pages** lists every page. Open one, or choose **New page**.

- **General**: title, description, the layout to use, whether search engines may index it and whether it appears in the sitemap.
- **Address**: type it without `/pages` or `.html`. A part in square brackets is a variable: `blog/[slug]` answers `/blog/anything`.
- **Compose**: build the page by adding components from the library, filling in each one's fields, and reordering. No code needed.
- **Code**: the page as text for anything compose cannot say. Switching to code always works; switching back works only if the page is still a plain list of components.
- **SEO**, **Scripts**, **Style**: search appearance for this page, and page-only JavaScript and CSS.
- **Preview**: shows the unsaved draft at phone, tablet and desktop widths. Nothing is published until you save.
- **Templates**: the orange button offers ready-made starting pages (landing, pricing, FAQ, team, contact and more).

Saving checks the whole file and refuses a broken one, saying what is wrong. Pages can be exported and imported as a zip; an import adds or updates and never deletes.

## Components

**Webmaster → Components** lists the building blocks.

- **New component** asks what it should be; the AI writes it, saves it and opens it for you to adjust.
- A component has **Properties** (the fields editors fill in), **Data** (what it reads), a **Template** and its own **Style** that cannot leak into other parts of the page.
- **Library** lets you add a ready-made component from public collections; the styles are compiled into the component so nothing is loaded from the internet.
- **Import snippet** turns HTML you paste into a component.

## AI Page Designer

**Webmaster → AI Page Designer** is a chat that plans and builds a complete page. It proposes new components or tables and waits for your approval before creating them.
The page itself is saved only when you press **Save page**. **Templates** starts from a ready-made layout and works even without an AI key.

## Services

A **Service** is a saved question for your data. **Webmaster → Services** has three kinds:

| Kind       | What it is                                                               | Who may create it                             |
| ---------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| **Query**  | A safe, saved view over one content type (or, with more rights, a table) | `services.write` (table needs `services.sql`) |
| **SQL**    | A read-only `SELECT` with named parameters                               | `services.sql`                                |
| **Script** | Free-form server code                                                    | `services.script`                             |

A new Service is **off** until you switch it on. Whether a page can use it depends on the **Services** switch (use inside the site) and the **Public content API** switch (use over HTTP), both in Settings → All settings → Features. **Script** Services run with full access to the server, like a developer logged into it: grant that permission rarely.
Worked examples are in [Getting data into the page](../coding/getting-data-into-pages.md) and [Services in depth](../coding/services-in-depth.md).

## SEO Manager

Search appearance has three layers, the last one winning:

1. **Settings → SEO**: the site-wide defaults (social handles, verification tags).
2. **A page's own SEO section**: defaults for every address that page produces (for example all posts).
3. **Webmaster → SEO Manager**: a rule for one address or a pattern (`/blog/*`, `/docs/**`) that overrides the rest. It can also add custom meta tags and extra structured
   data (FAQ, HowTo, Product) for search and answer engines. **Suggest with AI** fills the form for you to check.

LinkedIn has no tags of its own; it reads Open Graph, which every page emits.

## Who may do this

Pages, components, services and SEO each have their own read and write permissions. Raw HTML and scripts reach every visitor, so give `pages.write` and
`components.write` only to people you would trust with the site itself.
