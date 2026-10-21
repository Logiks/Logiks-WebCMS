---
section: coding
title: The public API
summary: Read your content from another program, create drafts, and use API keys.
order: 80
---

# The public API

Everything a page can read is also available over HTTP, for mobile apps, other sites and scripts.

## Switches and keys

- **Anyone**: while **Settings → All settings → Features → Public content API** is on, the read endpoints answer without a key.
- **With a key**: a valid key works whether or not that switch is on, limited to the modules it is scoped to. Send either header:

```
Authorization: Bearer cms_…
X-API-Key: cms_…
```

Create keys under **System → API**. The key is shown once; only a hash is stored. A key has scopes (module ids, or all), its own requests-per-minute budget, an optional expiry, and can be disabled or
rotated at any time. Answers to a keyed request are never cached by a shared cache.

## Reading

Base address: `/api/v1`. Lists answer `{ "data": [...], "meta": { "page", "perPage", "total", "pages" } }`; single items `{ "data": {…} }`. Errors are
`{ "error": { "code", "message" } }`. (`/api/public/…` is the same data with the plain body, kept for older clients.)

```bash
curl https://example.com/api/v1/content/post?per_page=5&category=news
curl https://example.com/api/v1/content/post/hello-world
curl https://example.com/api/v1/terms/category
curl https://example.com/api/v1/menus/main
curl 'https://example.com/api/v1/search?q=pricing'
curl https://example.com/api/v1/services/branches?city=Pune
```

Parameters on a content list: `per_page` (1–50), `page`, `sort` (`newest` | `path`), `locale`, and one per taxonomy (`category=…`, `tag=…`).

## Writing (drafts only)

Writes exist only on `/api/v1`, need an API key with the scope `<module>:write` (`*` never includes writes), and can only create or change **drafts**. Publishing stays in the admin.

| Request                         | Does                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /api/v1/entries/:type`    | create a draft: `{ "title": "…", "slug"?: "…", "data": {…}, "termIds"?: [1,2], "locale"?: "en" }` |
| `PUT /api/v1/entries/:type/:id` | change a draft that the API created and nobody has published since                                |
| `POST /api/v1/contact`          | the site's contact form (`name`, `email`, `message`); anonymous while the public API is on        |

A `status` in the body is refused.

## The reference

- **OpenAPI 3.1** for the public API: `/api/v1/openapi.json`.
- The admin API (routes, their permissions and schemas): `/api/admin/api-reference/openapi.json?surface=admin` while signed in. **System → API** shows the same reference.

Both are generated from the modules' own manifests, so they cannot drift from what the code does.

## Security notes

- Treat a key like a password. Give each integration its own key and the narrowest scope.
- Rate limits apply per IP for anonymous callers and per key for keyed ones.
- CORS: browsers may call the API only from origins listed in Settings → Security → Allowed CORS origins.
- Never put a key in client-side code on a public page.
