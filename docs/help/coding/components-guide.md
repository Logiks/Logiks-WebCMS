---
section: coding
title: Writing components
summary: The anatomy of a component, its props and data, scoped CSS, and the habits that make one reusable.
order: 50
---

# Writing components

A component is **one file**: a JSON meta block, an optional `<style>`, an optional `<script>`, and a Liquid/HTML template. It lives at `components/<name>.html`, and a page uses it with
`{% render "<name>" %}`.

```html
<script type="application/json" data-cms="meta">
  {
    "title": "Feature grid",
    "description": "Three or more features in a responsive grid.",
    "props": {
      "heading": { "type": "string", "label": "Heading", "default": "Why choose us" },
      "columns": { "type": "number", "label": "Columns", "default": 3 },
      "dark": { "type": "boolean", "label": "Dark background", "default": false }
    },
    "api": [{ "name": "features", "url": "/api/v1/services/features" }]
  }
</script>
<style>
  :host {
    display: block;
  }
  .grid {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  }
  .card {
    padding: 1.25rem;
    border: 1px solid var(--line, #dde3e1);
    border-radius: 10px;
    background: var(--bg, #fff);
  }
  .dark {
    background: var(--ink, #14212a);
    color: #fff;
  }
</style>
<section class="{% if dark %}dark{% endif %}">
  <h2>{{ heading }}</h2>
  <div class="grid">
    {% for f in api.features.items %}
    <article class="card">
      <h3>{{ f.title }}</h3>
      <p>{{ f.summary }}</p>
    </article>
    {% endfor %}
  </div>
</section>
```

## The meta block

| Key           | Purpose                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | The name editors see in the component library                                                                                                                                                                    |
| `description` | One sentence on what it does and where it fits                                                                                                                                                                   |
| `props`       | The fields an editor fills in when adding the component to a page. Each has a `type` (`string`, `text`, `number`, `boolean`, `select`…), a `label`, an optional `default`. The editor builds the form from this. |
| `api`         | The data the component reads, see [Getting data into the page](getting-data-into-pages.md)                                                                                                                       |

If a prop is declared, the editor shows a field for it and uses the default in the preview. A prop that is not declared is still passed by `{% render "x", a: 1 %}`, but editors cannot see it.

## Props: design them for the person who will fill them in

- Name by purpose (`heading`, `image`, `cta_label`), not by position.
- Give every prop a **default** that makes sense, so a component looks right the moment it is added.
- Prefer a few props over a dozen. If you find yourself adding `color1`, `color2`, make a second component or use the theme's variables.
- Use `{% if cta_label != blank %}` to hide optional parts.

## The wrapper and scoped CSS

The platform wraps each component in an element and prefixes **every selector** in your `<style>` with that wrapper. So:

- `:host` is the wrapper itself. It has no box until you say `:host { display: block; }`.
- `h2 { … }` styles only this component's `h2`. You cannot reach, or be reached by, other components.
- `@media`, `@supports` and `@container` are scoped inside. `@keyframes` and `@font-face` are global, so prefix your animation names.
- Use the **theme's variables** so your component restyles with a new theme: `var(--accent)`, `var(--ink)`, `var(--muted)`, `var(--line)`, `var(--bg)`, `var(--soft)`. Always give a fallback: `var(--accent, #2b59c3)`.
- Refused: `@import`, `expression()`, and `javascript:` URLs.

## Scripts

A component may carry a `<script>`. Write a plain `<script>`; the platform adds the security nonce for you. Inline event attributes (`onclick="…"`) are blocked by the site's content security policy, so attach listeners in
the script. See [CSS, JavaScript and libraries](styling-and-scripts.md).

## Text and languages

Every visible string goes through `t`:

```liquid
<a href="/blog">{{ 'blog.all_posts' | t: 'All posts' }}</a>
```

Keys are `area.name`. The English fallback keeps the component working with no translation file; translators edit the rest under System → Translations.

## Accessibility and quality checklist

- One `<h1>` per page (usually the page, not a component). Components use `h2` and below, and keep the order logical.
- Images: `alt` from the data (`featuredImage.alt`), or `alt=""` when purely decorative.
- Links and buttons: real `<a>` and `<button>`, at least 44 px high on touch, visible keyboard focus (do not `outline: none` without a replacement).
- Colour contrast: text on a background should meet WCAG AA (4.5:1 for body text). The AI Testing screen checks this.
- Works at 375 px wide without horizontal scroll. Use `grid` with `auto-fit`/`minmax`, not fixed widths.
- Motion is subtle; respect `@media (prefers-reduced-motion: reduce)`.
- Nothing from the internet at run time: fonts, icons and scripts come from the site (System → Libraries).

## Composing components

```liquid
{% render "card", post: post, show_image: true %}
```

A card component takes one object (`post`) instead of eight scalars and decides what to show. This is how `post-list` uses `post-card` in the starter site. Pass `page`/`pages` to `pagination`.

Keep **data fetching in the outer component** and pass results down. Inner components then need no `api`, are easy to test with a hand-written object and cost no extra reads (a page may do at most 30).

## Starting points

- **Components → Library**: ready-made sections you can add and adjust.
- **Components → Import snippet**: paste HTML (including Tailwind markup); the Tailwind is compiled into the component's own scoped CSS at import.
- **Components → New component**: describe it and the AI writes and saves it; then you edit it.
- The starter site's components in `site/defaults/components/` are short, real examples: `hero`, `cta`, `post-card`, `post-list`, `pagination`, `contact-form`, `search-results`.

## Refused when you save

`<script>` that is not a plain block, `@import`, code-running CSS, a Liquid syntax error, an unknown filter or tag, a file over 200 KB, and a meta block that is not valid JSON. The message names the file and the problem.

## Exporting and sharing

Webmaster → Components exports every component as a zip and imports a zip as an add-or-update (never a delete). The same checks run on import as on a save.
