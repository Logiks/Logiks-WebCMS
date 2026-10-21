---
section: coding
title: Getting data into the page
summary: How a component asks the database for content, terms, menus, search results or your own tables, and prints them.
order: 30
---

# Getting data into the page

A page never queries the database. A **component** declares the data it needs in its `api` list, the platform fetches it **in-process** (no HTTP round trip) when the component renders, and the
answer appears as `api.<name>`.

```html
<script type="application/json" data-cms="meta">
  {
    "title": "Post list",
    "props": { "per_page": { "type": "number", "default": 10 } },
    "api": [
      {
        "name": "posts",
        "url": "/api/v1/content/post?per_page={{ per_page | default: 10 }}&page={{ query.page | default: 1 }}"
      },
      { "name": "cats", "url": "/api/v1/terms/category" }
    ]
  }
</script>
{% for post in api.posts.items %}{{ post.title }}{% endfor %} {% for c in api.cats.terms %}{{ c.name
}}{% endfor %}
```

## The rules

- Each entry has a `name` (becomes `api.<name>`) and a `url`.
- The `url` is itself Liquid, so it can use the component's arguments, `params`, `query` and `site`. **Always `url_encode` values you insert**: `?q={{ query.q | url_encode }}`.
- `"required": true`: if that data answers 404, the **whole page** is a 404 (right for "this post does not exist"). Otherwise `api.<name>` is simply empty.
- At most **30** reads per page.
- A page that lists `uses:` in its front matter is held to it. A component asking for a module the page did not list gets nothing, and the server log says what to add. A page without `uses` is unrestricted.
  The page editor's _Data this page may read_ panel works it out for you.

## What you can read

| Address                           | You get                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `/api/v1/content/<type>`          | a list of published entries                                                |
| `/api/v1/content/<type>/<path>`   | one entry                                                                  |
| `/api/v1/terms/<taxonomy>`        | the categories or tags that are in use                                     |
| `/api/v1/terms/<taxonomy>/<slug>` | one term                                                                   |
| `/api/v1/menus/<name>`            | one menu                                                                   |
| `/api/v1/search?q=`               | search results                                                             |
| `/api/v1/services/<slug>?…`       | the answer of a [Service](services-in-depth.md): your table, SQL or script |
| `/api/v1/content`                 | the list of content types                                                  |

`/api/public/…` is the older address of the same data and also works.

### A list: `content/<type>`

Parameters: `per_page` (1–50, default 10), `page`, `sort` (`newest` or `path`), `locale`, and one parameter per taxonomy of the type (`category=news`, `tag=ai`).

```
api.posts = {
  items:   [ …entries… ],
  page:    1,
  perPage: 10,
  total:   42,
  pages:   5
}
```

### One entry: `content/<type>/<path>`

```
api.post = { item: { … }, breadcrumbs: […], children: […] }     // breadcrumbs/children only for hierarchical types
```

### What an entry (`item`) looks like

| Field                                  | Meaning                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `id`, `type`, `locale`, `slug`, `path` | identity; `path` includes parents for hierarchical types                                                        |
| `url`                                  | the entry's address on the site                                                                                 |
| `title`, `excerpt`, `author`           | text; `excerpt` is the entry's summary or the start of the body                                                 |
| `publishedAt`, `updatedAt`             | ISO dates; use `date` to format                                                                                 |
| `featuredImage`                        | `null`, or an image with `src`, `srcset`, `alt` and size information                                            |
| `terms`                                | list of `{id, name, slug, taxonomy, url}`                                                                       |
| `fields.<name>`                        | the type's own fields. A rich field is `{ html, blocks }`; a media field is an image; the rest are plain values |

```liquid
{% assign post = api.post.item %}
{% seo item: post %}
<h1>{{ post.title }}</h1>
<time datetime="{{ post.publishedAt }}">{{ post.publishedAt | date: '%-d %B %Y' }}</time>
{% if post.featuredImage %}
  <img src="{{ post.featuredImage.src }}" srcset="{{ post.featuredImage.srcset }}" alt="{{ post.featuredImage.alt }}">
{% endif %}
{{ post.fields.body.html }}
{% for t in post.terms %}<a href="{{ t.url }}">{{ t.name }}</a>{% endfor %}
```

Output is escaped; only `fields.<x>.html` is trusted markup, because it was cleaned on save and again on render.

### Menus, terms, search

```
api.menu   = { name: "main", items: [ { label, url, active, children: […] } ] }
api.cats   = { terms: [ { id, slug, name, parentId, url } ] }
api.cat    = { term:  { id, slug, name, taxonomy, url } }
api.found  = { query, page, perPage, total, pages, results: [ { id, type, title, url, excerpt } ] }
```

## Dynamic pages: from the address to the data

A page file named `blog/[slug].html` answers `/blog/anything` and receives `params.slug`. Pass it on to a component, which puts it in its own `url`:

```html
---
title: Post
entry: post
---

{% render "post", slug: params.slug %}
```

```json
"props": { "slug": { "type": "string" } },
"api": [ { "name": "post", "url": "/api/v1/content/post/{{ slug | url_encode }}", "required": true } ]
```

If the post does not exist the page is a 404, with no extra code.

The `entry:` line tells the platform which content this page shows, which is what gives each entry its address (links in menus, the sitemap, search results). See [Site structure](../../SITE-STRUCTURE.md#2-pages-and-addresses).

## Paging

```liquid
{% render "pagination", page: api.posts.page, pages: api.posts.pages %}
```

Read the current page from the query string: `&page={{ query.page | default: 1 }}`. Only the first ten pages of a list are cached, so that nobody can fill the cache by asking for `?page=99999`.

## Your own tables

Use a **Service**. A Service is an admin-defined endpoint over your data, with named parameters and a result shape you control. From a component it is just another address:

```json
"api": [ { "name": "branches", "url": "/api/v1/services/branches?city={{ query.city | url_encode }}" } ]
```

```liquid
{% for b in api.branches.items %}<li>{{ b.name }}, {{ b.city }}</li>{% else %}<li>No branches there.</li>{% endfor %}
```

Everything about writing one is in [Services in depth](services-in-depth.md). Switches that must be on: **Settings → All settings → Features → Services** (for use inside the site).

## Caching and freshness

- A rendered page is cached for **Settings → Website → Page cache lifetime** (300 s by default). The platform tags each page with what it read, so **editing content refreshes exactly the pages that show it**.
- Data the platform cannot tag, such as the answer of a Service over **your own table**, is not tracked. Such a page can show old rows for up to the cache lifetime. If the data must be
  fresh on every view, put `cache: false` in the page's front matter (and keep the page cheap), or accept the delay.
- Editing a page, component, theme or SEO rule refreshes **all** pages, because any of them can change what an address shows.
- `required` data that 404s is never cached as a 404 for a made-up address.

## Languages

Add `locale={{ site.locale }}` to a list or entry URL when Multiple languages is on, and wrap every visible word in `{{ 'key' | t: 'English' }}`.

## Checklist

1. Does the component declare the data (`api`) it prints?
2. Is every inserted value `url_encode`d?
3. Is there an empty state (`{% else %}` in the loop)?
4. Does a missing item make the page a 404 (`required`) instead of an empty shell?
5. Does the page set `uses:` if you want it limited?
6. Does the page use `cache: false` only where it must?
