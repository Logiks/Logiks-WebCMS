---
section: coding
title: Liquid in this CMS
summary: The template language for pages, components and themes: syntax, what is available, what is blocked, and the CMS's own tags and filters.
order: 20
---

# Liquid in this CMS

Pages, components and themes are written in [Liquid](https://liquidjs.com) (the LiquidJS engine). Plain HTML works as it is; Liquid adds three things.

| You write           | It is                                      |
| ------------------- | ------------------------------------------ |
| `{{ post.title }}`  | **Output**: prints a value, escaped        |
| `{% if … %}`        | **Tag**: logic and structure               |
| `{{ x \| upcase }}` | **Filter**: changes a value on its way out |

Templates run in a **sandbox**: they can print the data the site gives them and nothing else. There is no file access, no network, no way to read JavaScript objects, and a time and memory
limit per page (Settings → Themes; 500 ms and 64 MB by default) so a runaway loop stops the page, not the server.

## Output and escaping

```liquid
{{ page.title }}                 {# safe whatever an editor typed: & < > " are escaped #}
{{ post.fields.body.html }}      {# content HTML: cleaned when saved, so printed as markup #}
{{ seo.head }}                   {# the <head> tags, printed as markup #}
```

Only block HTML from content (`fields.<name>.html`) and `seo.head` print as markup. There is no `raw` filter, so a template cannot turn text into HTML.
`{# … #}` is a comment.

## Variables

```liquid
{% assign heading = 'Latest' %}
{% assign first = api.posts.items | first %}
{% capture cls %}card card--{{ type }}{% endcapture %}
{% increment hits %}
```

A component also sees the arguments it was rendered with (`{% render "card", title: "Hi" %}` gives `title`).

## Conditions

```liquid
{% if post.featuredImage %}…{% elsif page.layout == 'landing' %}…{% else %}…{% endif %}
{% unless query.q == blank %}…{% endunless %}
{% case post.type %}{% when 'post' %}…{% when 'page' %}…{% endcase %}
```

Operators: `==  !=  >  <  >=  <=  and  or  contains`. Falsy values are `false`, `nil` (missing) and nothing else: an empty string and `0` are **true**. Test for empty with `!= blank` (or `== blank`).

## Loops

```liquid
{% for post in api.posts.items limit: 6 offset: 0 %}
  {{ forloop.index }} of {{ forloop.length }}: {{ post.title }}
  {% if forloop.first %}…{% endif %}
{% else %}
  Nothing here.
{% endfor %}

{% for i in (1..5) %}{{ i }}{% endfor %}
{% tablerow p in products cols: 3 %}{{ p.name }}{% endtablerow %}
{% cycle 'odd', 'even' %}
```

`break` and `continue` work inside loops. A `for … else` runs the `else` when the list is empty, which is the right place for an empty state.

## Reusing templates

```liquid
{% render "hero", heading: "Hello", image: item.featuredImage %}   {# a SITE component: components/hero.html #}
{% render "theme/header" %}                                          {# a THEME component #}
{% render "plugin/weather-demo/current" %}                          {# a component shipped by a plugin #}
```

- `render` gives the component **only** the arguments you pass (plus the globals below). It cannot see the variables of the page that called it.
- There is no `include`. A template cannot reach anything outside the site, theme and plugin namespaces.
- Pass an object whole (`post: post`) instead of many scalar arguments when a card needs several fields.

## What every template can see

| Name                 | Contents                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `site`               | `name`, `tagline`, `url`, `locale`, `year`, `home`, `home_page`, `posts_per_page`, `languages` (`code`, `name`, `current`) |
| `menus`              | `menus.main`, `menus.footer`… each a list of `{label, url, active, children}`                                              |
| `settings`           | the active theme's settings                                                                                                |
| `seo`                | `head` (print inside `<head>`), `title`, `description`, `canonical`, `image`                                               |
| `page`               | `title`, `description`, `url`, `layout`, `front` (any front-matter key of the page)                                        |
| `params`, `query`    | address parts of a dynamic page (`params.slug`); the query string (`query.q`, `query.page`)                                |
| `request`, `contact` | `request.path`; the contact form's `enabled`, `token`, `sent`, `error`                                                     |
| `preview`            | `true` when an editor is previewing a draft                                                                                |
| `api`                | inside a component: the data it declared (see [Getting data into the page](getting-data-into-pages.md))                    |

Content is **not** a global. A component gets content only through the endpoints it declares.

## The tags this CMS adds

```liquid
{% seo title: 'Pricing', description: 'Plans and prices.', image: item.featuredImage.src, type: 'article', noindex: false %}
{% seo item: post %}              {# an entry fills in title, description, image, structured data, breadcrumbs, hreflang #}
{% not_found %}                   {# make the whole page a 404 (framed by the theme) #}
{% redirect to: '/pricing', status: 301 %}
```

- `seo` can be used by a page or any component. Last one wins; a Webmaster → SEO Manager rule for the live address overrides all of it.
- `not_found` is for "the data I needed does not exist" when you did not mark the endpoint `required`.
- A `cms_api` tag is written for you at the top of a component that declares `api`; you never type it.

## Filters

All of the standard LiquidJS set is available **except** `raw` and `sample`:

- **Text**: `append prepend upcase downcase capitalize strip lstrip rstrip truncate truncatewords replace replace_first remove split slugify escape strip_html newline_to_br url_encode url_decode normalize_whitespace number_of_words`
- **Lists**: `first last join map where reject sort sort_natural reverse uniq compact concat size slice group_by find has sum push pop shift unshift`; the `_exp` variants take a condition (`where_exp: "p", "p.price < 10"`)
- **Numbers**: `plus minus times divided_by modulo round ceil floor abs at_least at_most`
- **Dates**: `date date_to_string date_to_long_string date_to_rfc822 date_to_xmlschema`; `{{ post.publishedAt | date: '%-d %B %Y' }}` (UTC)
- **Other**: `default json jsonify to_integer base64_encode sha256`

and these four, which are the CMS's own:

| Filter         | Use                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `t`            | `{{ 'blog.older' \| t: 'Older posts' }}`: a translated string. Second argument is the English fallback. **Use it for every visible word.** |
| `asset_url`    | `{{ 'logo.svg' \| asset_url }}` in a theme: a hashed URL for a theme file, cacheable for a year                                            |
| `library_url`  | `{{ '@fortawesome/fontawesome-free/css/all.min.css' \| library_url }}`: a file of an installed library; empty if not installed             |
| `absolute_url` | `{{ '/about' \| absolute_url }}`: the full URL with the site's address                                                                     |
| `handle`       | `{{ 'Hello World' \| handle }}` → `hello-world`                                                                                            |

An unknown filter is an **error**, not a silent no-op: the save is refused and names it.

## Allowed tags

`assign capture case comment cycle decrement echo for if increment layout block liquid raw render tablerow unless break continue` plus `seo not_found redirect`. Anything else
(for example `include`) is refused when you save.

## Common mistakes

| Mistake                                          | Fix                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `{% if count %}` is always true even when `0`    | Compare: `{% if count > 0 %}`                                                                                |
| Printing HTML and seeing `&lt;p&gt;`             | Print the `.html` of a rich field (`post.fields.body.html`), not the block document                          |
| A variable from the page is empty in a component | Pass it: `{% render "card", post: post %}`                                                                   |
| `{{ api.posts }}` is empty                       | The component does not declare that `api` name, the address 404ed, or the page's `uses:` excludes the module |
| `Unknown filter`                                 | Check the spelling against the list above                                                                    |
| Hard-coded English                               | Wrap it: `{{ 'key' \| t: 'English' }}`                                                                       |
| Spaces: `{% assign x = a                         | b %}`                                                                                                        | Filters need no special spacing, but arguments are `filter: arg1, arg2` |

## Debugging

- `{{ post | json }}` prints a whole object as JSON while you work out what is inside. Remove it afterwards.
- The page editor's **Preview** reports Liquid errors with the line and marks them in the editor.
- Saving validates the whole file, so a typo never reaches visitors.
