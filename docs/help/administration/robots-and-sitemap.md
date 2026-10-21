---
section: administration
title: robots.txt and sitemap.xml
summary: How to add rules to robots.txt, and how to remove, add or change what sitemap.xml lists, by hand.
order: 55
---

# robots.txt and sitemap.xml

Both files are **generated** by the platform; there is no file to upload or edit on the server. You change what they say with settings, and the next request shows the result.

|               | Tells search engines…                | Address        | Edited at                                                    |
| ------------- | ------------------------------------ | -------------- | ------------------------------------------------------------ |
| `robots.txt`  | where they may and may not **crawl** | `/robots.txt`  | Settings → All settings → Website → _Extra robots.txt lines_ |
| `sitemap.xml` | which addresses you **want listed**  | `/sitemap.xml` | System → Sitemap                                             |

## robots.txt

### What it contains by default

```
User-agent: *
Disallow: /admin
Disallow: /api/
Disallow: /preview/
Disallow: /search

Sitemap: https://example.com/sitemap.xml
```

The `Sitemap:` line appears when the sitemap is on (Settings → Website → _Publish sitemap.xml_). Open `/robots.txt` in a browser to see exactly what is served now.

### Adding your own lines

1. **Settings → All settings → Website**.
2. Put one rule per line in **Extra robots.txt lines**.
3. **Save changes**. The file updates on every server within seconds; browsers and crawlers may keep the old copy for up to 5 minutes.

Your lines are added **after** the standard ones, as written. Examples:

```
Disallow: /private/
Disallow: /thank-you
Allow: /private/public-report.html
Crawl-delay: 10

User-agent: GPTBot
Disallow: /

User-agent: Googlebot-Image
Disallow: /media/
```

A `User-agent:` line starts a new group; the lines under it apply to that crawler only. The `Sitemap:` line is unaffected by groups.

From the command line: `npm run cli -- config:set site.robots_extra "Disallow: /private/"` (the value is a single string; use the admin for several lines).

### What you cannot do

- **Remove the standard `Disallow` lines** (`/admin`, `/api/`, `/preview/`, `/search`) or change the `User-agent: *` line. They protect the admin and are always sent. If you truly need a completely different file, serve `/robots.txt` from your web server or load balancer in front of the platform.
- **Hide a page from search with robots.txt.** `Disallow` stops crawling, not listing: a blocked address that other sites link to can still appear in results, and the crawler can no longer read a `noindex` tag on it. To keep a page out of search, use **noindex** (below) and leave it crawlable.
- **Secure anything.** robots.txt is public and only a request. Use permissions for private content.

### Block the whole site (staging)

**Settings → Website → Ask search engines not to index this site**. This sends `Disallow: /` for everyone, adds a noindex header and meta tag to every page, **removes the Sitemap line and turns `sitemap.xml` off**. Turn it off before launch.

### Keep one page out of search

Choose one:

- A page: set **noindex** in its SEO section (or `noindex: true` in the front matter).
- One address or a pattern: Webmaster → SEO Manager → a rule with **noindex** on.
- One content entry: tick **Hide from search engines** in its editor.

A noindex page is also left out of the sitemap, whichever of these set it. An SEO Manager rule with noindex on removes its address from the sitemap, and turning the rule off or deleting it puts the address back.

## sitemap.xml

Open **System → Sitemap**. The screen shows the list of addresses it would publish, the settings that shape it, and a preview. Needs `sitemap.read` to look and `sitemap.manage` to change.

### What is listed by default

- the site's **fixed pages** (those with a plain address; not `404`, and not pages marked `sitemap: false` or `noindex: true`),
- **published content** at the address a page gives it (an entry that no page shows has no address, so it is left out; entries marked _Hide from search engines_ are left out),
- **category and tag pages** that have at least one entry,
- each entry's **featured image**, as an image tag,
- always `/` when anything is listed.

### Remove something

Pick the lightest tool that fits.

| To remove…                       | Do this                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| One fixed page                   | In Webmaster → Site pages, untick the page's sitemap option on the General tab (in code it is `sitemap: false` in the front matter) |
| One or more addresses by pattern | Sitemap **Rules**: add `/thank-you` or `/tag/*` and set it to **Leave out**                                                         |
| A whole kind of content          | **Content types to leave out**: the type id, one per line (for example `post`)                                                      |
| All category/tag pages           | Untick **List category and tag pages**                                                                                              |
| All fixed pages / all content    | Untick **List the site's fixed pages** / **List published content**                                                                 |
| Everything                       | Settings → Website → untick **Publish sitemap.xml**; `/sitemap.xml` then answers 404                                                |
| One entry                        | Tick **Hide from search engines** in the entry                                                                                      |

### Rules: change or exclude by address

Rules match an address, **the first matching rule wins**, and `*` matches within one part of the address while `**` matches across parts. In the screen choose **Add rule** and pick _Leave out_ or _List_; as JSON (Settings → All settings → Sitemap → Rules) it looks like:

```json
[
  { "pattern": "/thank-you", "exclude": true },
  { "pattern": "/tag/*", "exclude": true },
  { "pattern": "/blog/**", "changefreq": "daily", "priority": 0.8 },
  { "pattern": "/legal/**", "changefreq": "yearly", "priority": 0.2 }
]
```

Put the specific rule before the general one: `/blog/archive` (exclude) must come before `/blog/**`.

### Add something

- **Extra addresses**: one per line, on this site, for example `/landing/spring`. Use it for pages that exist but are not found by the other sources (a file served some other way).
- A page you built under Webmaster → Site pages is listed automatically. A **dynamic page** (`blog/[slug]`) is listed through the entries it shows, not as itself.

### Change the hints

**How often pages change (default)** and **Priority (default)** apply to everything; a rule overrides them for its addresses. Both are only hints: Google ignores them. `lastmod` comes from when the entry or page was last changed.

### See it, rebuild it, check it

1. **System → Sitemap** lists the addresses and where each came from (page, entry type, term, extra), plus how many were skipped by rules.
2. The sitemap is built from a **cache** that is refreshed when pages, content, SEO or the site tree change, and at the latest after an hour. If you edited something and do not see it, choose **Rebuild now**.
3. **Download** gives the complete list as one file, whatever the split.
4. Open `/sitemap.xml` in a browser to check what crawlers get. Responses may be cached for 5 minutes.
5. Submit `https://your-site/sitemap.xml` in Google Search Console and Bing Webmaster Tools once. They re-read it themselves.

A long site is split automatically: past **Addresses per file** (default 10,000) `/sitemap.xml` becomes an index pointing at `/sitemap-1.xml`, `/sitemap-2.xml` and so on. Do not submit the parts separately.

### Common problems

| Symptom                                          | Cause and fix                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `/sitemap.xml` is a 404                          | Sitemap switched off, **Ask search engines not to index** is on, or the Sitemap module is off (Settings → Modules)            |
| A new post is missing                            | It is not published yet, its type is excluded, no page shows that type, or the cache has not refreshed: **Rebuild now**       |
| A page I made is missing                         | It has `sitemap: false` or `noindex: true`, or it is a dynamic page (listed through its entries)                              |
| An address I excluded is still listed            | A rule above it matched first, or it came in as an **Extra address**: extras are checked by rules too, so add an exclude rule |
| Search Console says "URLs blocked by robots.txt" | A `Disallow` line covers a listed address. Remove it from _Extra robots.txt lines_, or exclude the address from the sitemap   |
| Google lists a page that is noindex              | Crawling is blocked by robots.txt so the tag cannot be read. Allow crawling and keep noindex                                  |
