---
section: coding
title: Coding guide: start here
summary: The mental model and a ten-minute walkthrough from an empty page to a page that shows live data.
order: 10
---

# Coding guide: start here

You can build the whole public site from the admin, with no files and no deploy. This guide is for people who want to write the templates themselves, or to understand what the
AI wrote.

## The model in one picture

```
address  ──►  PAGE            pages/blog/[slug].html      (front matter + Liquid body)
                │ renders
                ▼
            COMPONENTS        components/post.html        (template + scoped CSS + the data it reads)
                │ read data through endpoints they declare
                ▼
            DATA              content, terms, menus, search, Services (your tables, SQL, scripts)
                │
every page is wrapped by the THEME: layouts/default.html, header, footer, styles
```

Five rules explain almost everything:

1. **Every address is a page.** There are no other templates and no other routing. `404.html` is a page too.
2. **Content is data.** A post is not a template; a component fetches posts and prints them.
3. **A component declares the data it needs** in a small JSON block. Nothing is global, so you can read a component and know what it depends on.
4. **The theme is only the frame.** Change the theme and your pages and components stay.
5. **Everything is escaped on output** unless it is content HTML that was cleaned on save. You cannot turn text into markup by accident.

## Ten minutes: a page that shows live data

You need the permissions `pages.write` and `components.write`.

### 1. A component

**Webmaster → Components → New component** (or start blank). Name it `latest-posts` and use the Template, Properties and Data tabs, or paste this as the whole file with _edit as code_:

```html
<script type="application/json" data-cms="meta">
  {
    "title": "Latest posts",
    "props": { "heading": { "type": "string", "label": "Heading", "default": "Latest" } },
    "api": [{ "name": "posts", "url": "/api/v1/content/post?per_page=3" }]
  }
</script>
<style>
  :host {
    display: block;
  }
  ul {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  a {
    color: var(--accent, #2b59c3);
  }
</style>
<section>
  <h2>{{ heading }}</h2>
  <ul>
    {% for post in api.posts.items %}
    <li><a href="{{ post.url }}">{{ post.title }}</a></li>
    {% else %}
    <li>{{ 'blog.empty' | t: 'Nothing published yet.' }}</li>
    {% endfor %}
  </ul>
</section>
```

The `api` entry is why `api.posts.items` exists. The `<style>` applies only inside this component.

### 2. A page

**Webmaster → Site pages → New page**. Address `news`, then in _Code_:

```html
---
title: News
description: What is new.
---

{% seo title: 'News' %} {% render "latest-posts", heading: "What is new" %}
```

Open `/news`. Use **Preview** before saving; it shows the unsaved draft at phone, tablet and desktop widths.

### 3. Change the data, not the template

Publish a post: `/news` shows it within moments. Edit the component's `per_page` to `6`: every page that uses the component changes.

## Where to go next

| You want to…                                        | Read                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Learn the template language                         | [Liquid in this CMS](liquid-guide.md)                                                             |
| Pull in posts, menus, search or your own tables     | [Getting data into the page](getting-data-into-pages.md)                                          |
| Expose your own table or logic                      | [Services in depth](services-in-depth.md)                                                         |
| Build a reusable block well                         | [Writing components](components-guide.md)                                                         |
| Style and script it                                 | [CSS, JavaScript and libraries](styling-and-scripts.md)                                           |
| Copy a working recipe                               | [Cookbook](cookbook.md)                                                                           |
| Read content from another program                   | [The public API](public-api.md)                                                                   |
| Add an admin screen or server route                 | [Plugins](plugins-guide.md)                                                                       |
| Know exactly how routing, caching and security work | [Site structure](../../SITE-STRUCTURE.md), [Themes](../../THEMES.md), [Modules](../../MODULES.md) |
