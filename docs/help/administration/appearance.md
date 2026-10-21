---
section: administration
title: Appearance, menus and libraries
summary: Switch and customise the theme, edit its files, build menus and add fonts or CSS packages.
order: 40
---

# Appearance, menus and libraries

## Themes

A theme is the **frame** of every page: header, footer, fonts, colours and scripts. It holds no pages and no content, so **changing the theme changes only the
frame**. Everything under **Appearance**:

- **Themes**: install a `.zip`, make one live, **Duplicate**, **Export .zip**, remove. Two themes ship with the platform (`default` and `midnight`).
- **Customize**: the options the theme offers (colours, fonts, spacing) and **custom CSS**, with a live preview that shows your unsaved changes. Each theme keeps its own custom CSS,
  printed last so it wins. It may not contain markup, `@import`, or code-running CSS.
- **Theme editor**: edit, add, upload and delete the files of an **installed** theme. Every save checks the whole theme as an upload would and refuses a broken one,
  naming the file. Built-in themes are read-only: **Duplicate** one to get an editable copy.

After you switch or edit a theme, browsers and CDNs may show the old look for up to five minutes. Servers all switch within seconds.

## Menus

**Appearance → Menus** builds the lists of links the theme shows (main, footer, anything else you name). Each item has a label and links either to **a page** (picked from your content) or to **an address** (`/about` or a full `https://…` link).
Use **Add sub-item** for drop-downs (up to three levels) and the arrows to reorder. A theme prints a menu by name, so renaming `main` stops it appearing until the theme is told.

## Translations

**System → Translations** holds the site's fixed wording per language. Only what you change is stored; the rest comes from the shipped wording and the theme. See
[Content and media](content-and-media.md#languages).

## Libraries

**System → Libraries** installs packages from npm (such as icon fonts, a lightbox, a CSS framework) and serves them from your own site, so visitors never
load anything from the internet at run time and the site's content security policy stays tight.

- **Load on every page**: the chosen stylesheets go into every page's head.
- **Use one file**: a developer writes `{{ 'pkg/path' | library_url }}` and gets that file's address.
- **Files from a CDN** copies a file or stylesheet (with its fonts) from a CDN link onto your site once, then serves it locally.
- **Scripts from libraries are off** until you allow them in Settings → Libraries: a library script runs in your visitors' browsers.

Installing needs the server to reach the package registry (npm by default).

## Check the result

Open the live site on a phone-sized window after any theme change. **Automation → AI Testing** can crawl the whole site at phone, tablet and desktop widths
and report layout, contrast, spelling and broken links.
