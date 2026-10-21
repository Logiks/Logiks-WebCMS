---
section: coding
title: 'Reference: writing a theme'
summary: 'Theme layout, theme.json, what templates receive, the sandbox rules and helpers.'
order: 110
---

# Writing a theme

A theme is the **frame** around the site: layouts, common components (header, footer), styles, scripts, wording and images. It does not
contain pages or content; those belong to the site (see [SITE-STRUCTURE.md](SITE-STRUCTURE.md)), so **changing the theme changes only
the theme**. A theme is a folder (or a `.zip` of it) of [Liquid](https://liquidjs.com) templates and CSS. Templates run in a sandbox: they can
print the data the site gives them and nothing else. Install one under **Appearance → Themes**; the built-in themes live in
[`site/themes/default/`](../site/themes/default) (the fuller example) and [`site/themes/midnight/`](../site/themes/midnight) (the smallest).

```
theme.json                 id, name, version, the settings the theme offers, which styles/ and scripts/ files every page loads
layouts/default.html       the frame: <html>, header, footer. REQUIRED. More frames (landing.html…) are chosen by a page's `layout:`
components/<name>.html     common components (header, footer…): template + scoped <style>, used as {% render "theme/<name>" %}
styles/*.css               loaded on every page, alphabetically or in the order of theme.json "styles": ["site.css"]
scripts/*.js               the same for "scripts". Refused in installed themes unless Settings → Themes allows JavaScript
locales/<code>.json        the theme's own wording, for {{ 'layout.skip' | t }}; merged with the site's locales (edited > shipped `site/locales` > theme)
assets/                    images, fonts, other css (served at hashed URLs)
```

Installing a theme compiles every layout and component (a component's CSS and meta are checked too) and renders `layouts/default.html`
once, so mistakes are reported with the file name instead of reaching visitors.

## Changing a theme in the admin (Appearance)

- **Themes**: install (zip), make live, **Duplicate**, **Export .zip**, remove.
- **Theme editor**: edit, add, upload (images, fonts) and delete the files of an **installed** theme. Every save checks the whole theme
  exactly as an upload would (paths, types, sizes, `theme.json`, and the compile + dry-run render), so a broken template is refused with its
  file name and nothing changes. **Built-in themes are read-only** (they ship with the code and would be overwritten by the next update):
  **Duplicate** one to get an editable copy, with the original's options. The id in `theme.json` can't change; duplicate to make a new id.
- **Customize**: the theme's options (its `theme.json` settings) and **custom CSS**, with a live preview of any address that renders your
  unsaved changes. Each theme has its own custom CSS; it is printed last in `<head>` (after library stylesheets, the theme's styles and the
  components' CSS), so it wins. It may not contain markup, `@import` (install a stylesheet package under System → Libraries instead),
  `expression()`/`behavior`/`-moz-binding`, or `javascript:`/non-image `data:` URLs. The same values are on Settings → "Theme: <name>".

Every change is audited and reaches every server within seconds.

## The layout

```liquid
<!doctype html>
<html lang="{{ site.locale }}">
<head>
  {{ seo.head }}                 {# title, description, canonical, Open Graph, structured data #}
  {{ content_for_header }}       {# the theme's stylesheets and the scoped CSS of the components the page used #}
</head>
<body>
  {% render "theme/header" %}
  <main id="main">{{ content_for_layout }}</main>   {# the page #}
  {% render "theme/footer" %}
  {{ content_for_footer }}       {# the theme's scripts #}
</body>
</html>
```

A layout that forgets `content_for_header` / `content_for_footer` still gets its styles and scripts, at the ends of `<head>` and `<body>`.

Design for the switch: keep colours, spacing and fonts in **CSS variables** on `:root` (`--ink --muted --line --bg --soft --accent`). The
site's components use them, so a new theme restyles them by changing the variables, not their markup. Theme components can only see the
globals below and what a layout passes with `{% render "theme/x", arg: value %}`.

## theme.json

```json
{
  "id": "acme",
  "name": "Acme",
  "version": "1.2.0",
  "description": "…",
  "author": "…",
  "styles": ["site.css"],
  "settings": {
    "accent_color": { "type": "string", "label": "Accent colour", "default": "#2b59c3" }
  }
}
```

`id`: lowercase letters, numbers, underscores. Setting types: `string`, `text`, `number`, `boolean`, `select` (with `options`). They appear on
the Settings screen as “Theme: Acme” and reach templates as `{{ settings.accent_color }}`.

## What templates receive

Visible everywhere, including inside components:

| Name                 | Contents                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `site`               | `name`, `tagline`, `url`, `locale`, `year`, `home`, `home_page`, `posts_per_page`, `languages` (`code`, `name`, `current`) |
| `menus`              | `menus.main`, `menus.footer`, … each a list of `{label, url, active, children}`                                            |
| `settings`           | this theme's settings                                                                                                      |
| `seo`                | `head` (print it inside `<head>`), plus `title`, `description`, `canonical`, `image`                                       |
| `page`               | `title`, `description`, `url`, `layout`, `front` (any front-matter key of the page)                                        |
| `params`, `query`    | the address parts of a dynamic page (`params.slug`); `query.q`, `query.page`                                               |
| `request`, `contact` | `path`; the contact form's `enabled`, `token`, `sent`, `error`                                                             |
| `preview`            | true when an editor is previewing a draft                                                                                  |

Content is not a global: the site's components read it through the endpoints they declare.

## Rules the sandbox enforces

- **Output is escaped.** `{{ page.title }}` is safe whatever an editor typed. Only block html from content (`fields.body.html`) and `seo.head`
  print as HTML. There is no `raw` filter, so a theme can't turn text into markup.
- **Only the site's and the theme's own components can be reached** (`{% render "x" %}`, `{% render "theme/x" %}`); paths that leave them
  fail. There is no `include`, no file or network access, and no way to read JavaScript objects (`{{ x.constructor }}` prints nothing).
- **Time and memory are limited** (Settings → Themes, default 500 ms and 64 MB per page), so a runaway loop stops the page, not the server.
  If the active theme fails at render time, visitors get the built-in theme's page instead of an error.
- **Allowed tags:** `assign capture case comment cycle decrement echo for if increment layout block liquid raw render tablerow unless break continue`
  plus `seo not_found redirect`. **Filters:** the standard LiquidJS set except `raw` and `sample`, plus `asset_url`, `library_url`, `t`, `absolute_url`, `handle`.
- **Zip rules:** at most 400 files; 2 MB per file, 300 KB per template, 10 MB unpacked; extensions `html json css js txt md png jpg jpeg gif webp avif ico woff woff2 ttf svg`;
  folders `layouts components styles scripts assets locales`; no symlinks, no `..`, no absolute paths. **JavaScript is refused unless allowed in Settings → Themes**:
  a theme script runs in your visitors' browsers on the same address as the admin, so only allow it for themes you'd trust with your own admin session.

## Helpers

`{{ 'photo.jpg' | asset_url }}` → a hashed URL that changes whenever any file in the theme changes (so it can be cached for a year); `styles/x.css`
and `scripts/x.js` work too · `{{ 'layout.skip' | t }}` or `{{ 'layout.skip' | t: 'Skip' }}` → a string from the merged locales (edited over shipped over theme; visitor's
language, its base language, the default language, English, the fallback text, the key) · `{{ '/about' | absolute_url }}` · `{{ 'Hello World' | handle }}`
· dates: `{{ post.publishedAt | date: '%-d %B %Y' }}` (UTC) · `{{ '@fortawesome/fontawesome-free/css/all.min.css' | library_url }}` → that file
of the installed version of a library (System → Libraries), or an empty string when it isn't installed. A library set to "load on every page"
needs no tag at all: its chosen stylesheets are added to `<head>` before the theme's.
