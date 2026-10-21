---
section: coding
title: Cookbook
summary: Working recipes: lists, detail pages, filters, search, forms, table-backed pages, redirects and more.
order: 70
---

# Cookbook

Each recipe is self-contained. Components go in Webmaster → Components, pages in Webmaster → Site pages.

## 1. A card grid of the latest posts

`components/latest-grid.html`

```html
<script type="application/json" data-cms="meta">
  {
    "title": "Latest grid",
    "props": { "count": { "type": "number", "default": 6 } },
    "api": [{ "name": "posts", "url": "/api/v1/content/post?per_page={{ count | default: 6 }}" }]
  }
</script>
<style>
  :host {
    display: block;
  }
  .grid {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  }
  .card {
    border: 1px solid var(--line, #dde3e1);
    border-radius: 10px;
    overflow: hidden;
    background: var(--bg, #fff);
  }
  .card img {
    width: 100%;
    height: auto;
    display: block;
  }
  .card div {
    padding: 1rem;
  }
</style>
<div class="grid">
  {% for post in api.posts.items %}
  <a class="card" href="{{ post.url }}">
    {% if post.featuredImage %}<img
      src="{{ post.featuredImage.src }}"
      alt="{{ post.featuredImage.alt }}"
      loading="lazy"
    />{% endif %}
    <div>
      <h3>{{ post.title }}</h3>
      <p>{{ post.excerpt | truncate: 120 }}</p>
    </div>
  </a>
  {% else %}
  <p>{{ 'blog.empty' | t: 'Nothing published yet.' }}</p>
  {% endfor %}
</div>
```

## 2. A detail page that is a 404 when the item is missing

`pages/blog/[slug].html`

```html
---
title: Post
entry: post
---

{% render "post", slug: params.slug %}
```

The `post` component declares `"required": true` on its endpoint, so a made-up slug gives a real 404 and is never cached as one.

## 3. Posts of one category, from the address

`pages/category/[slug].html`

```html
---
title: Category
terms: category
---

{% render "term-posts", slug: params.slug %}
```

`term-posts` reads `/api/v1/terms/category/{{ slug | url_encode }}` (`required`) and `/api/v1/content/post?category={{ slug | url_encode }}`.

## 4. A search page

`pages/search.html`

```html
---
title: Search
cache: false
limit: search
noindex: true
---

<form action="/search" method="get" role="search">
  <label for="q">{{ 'search.label' | t: 'Search' }}</label>
  <input id="q" name="q" value="{{ query.q }}" type="search" />
  <button>{{ 'search.go' | t: 'Go' }}</button>
</form>
{% render "search-results" %}
```

The component reads `/api/v1/search?q={{ query.q | url_encode }}&page={{ query.page | default: 1 }}` and prints `api.found.results`. `limit: search` applies the search rate limit to visitors.

## 5. A page backed by your own table

1. **Service**: Webmaster → Services → New. Mode _Query_ → source _Table_ → `branches`, columns `id, name, city, phone`, filter `city = :city`, sort `name`, page size 20. Switch it on.
2. **Component** `branch-list`:

```html
<script type="application/json" data-cms="meta">
  {
    "title": "Branches",
    "api": [
      {
        "name": "b",
        "url": "/api/v1/services/branches?city={{ query.city | url_encode }}&page={{ query.page | default: 1 }}"
      }
    ]
  }
</script>
<form method="get">
  <label for="city">{{ 'branches.city' | t: 'City' }}</label>
  <input id="city" name="city" value="{{ query.city }}" />
  <button>{{ 'branches.filter' | t: 'Filter' }}</button>
</form>
<ul>
  {% for r in api.b.items %}
  <li>{{ r.name }} · {{ r.phone }}</li>
  {% else %}
  <li>{{ 'branches.none' | t: 'No branches found.' }}</li>
  {% endfor %}
</ul>
{% render "pagination", page: api.b.page, pages: api.b.pages %}
```

3. **Page** `branches` with `cache: false` if rows change outside the CMS and must show at once; then `{% render "branch-list" %}`.

## 6. A computed number from SQL

Service, mode _SQL_:

```sql
SELECT COUNT(*) AS total FROM orders WHERE created_at >= :since
```

Parameter `since` (number, required). Use it in a component: `/api/v1/services/orders-since?since={{ 'now' | date: '%s' | times: 1000 | minus: 86400000 }}`. (Timestamps in this platform are
epoch milliseconds.)

## 7. A form that posts somewhere safe

The contact form shipped with the starter site posts to `/contact` (turn it on in Settings → Website → Contact form). To post your own data, write a **script Service** that validates input and
writes with `ctx.db`, and call it from a small `<script>` using `fetch('/api/v1/services/…')`. Include a honeypot field and a token as the contact form does, and add a rate limit.

## 8. Breadcrumbs and children for a hierarchy

Content pages are hierarchical. A single-entry request returns `breadcrumbs` and `children`:

```liquid
{% assign crumbs = api.page.breadcrumbs %}
<nav aria-label="Breadcrumb"><ol>{% for c in crumbs %}<li>{% if forloop.last %}{{ c.title }}{% else %}<a href="{{ c.url }}">{{ c.title }}</a>{% endif %}</li>{% endfor %}</ol></nav>
```

## 9. A language switcher

```liquid
{% if site.languages.size > 1 %}
  <ul>{% for l in site.languages %}<li><a href="/{{ l.code }}{{ request.path }}"{% if l.current %} aria-current="true"{% endif %}>{{ l.name }}</a></li>{% endfor %}</ul>
{% endif %}
```

Needs **Multiple languages** on. Check how your site prefixes the default language before relying on this.

## 10. Pointing an old address elsewhere from a page

```html
---
title: Moved
---

{% redirect to: '/pricing', status: 301 %}
```

For many addresses use System → Redirects.

## 11. Structured data (FAQ) without code

Webmaster → SEO Manager → New rule for `/faq` → _Extra JSON-LD_:

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Do you ship abroad?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes, to 40 countries." }
    }
  ]
}
```

## 12. Run a Service on a schedule

Create a script Service `refresh-rates`, then Automation → Scheduler → New task → _Service_ → `refresh-rates`, every 60 minutes. The script can fetch an outside API and store rows with `ctx.db`;
components then read the stored rows with a table Service, so a slow outside API never slows a page.

## 13. Fire an event and notify another system

In any script Service: `await ctx.events.emit('lead.created', { id })`. In Automation → Webhooks add a webhook for `lead.*` pointing at your CRM, with a secret to sign the call.
