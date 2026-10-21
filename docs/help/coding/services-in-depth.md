---
section: coding
title: Services in depth
summary: Query, SQL and script Services: how to define them, parameters, results, security and testing.
order: 40
---

# Services in depth

A **Service** (Webmaster → Services) is a named, saved question for your data. It has a **slug**, a **mode**, optional **parameters** and an **enabled** switch. Once it is enabled and
**Settings → All settings → Features → Services** is on, any component can read it:

```
/api/v1/services/<slug>?param=value
```

and, if **Public content API** is also on and the Service is public, so can an outside program over HTTP.

A new Service starts **disabled**. Switch it on when you have tested it with the **Preview** panel in the editor.

## Choosing a mode

| Mode                    | Use when                                                                                  | Needs                                | Result shape                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| **Query: content type** | You want a fixed view of one content type (always these fields, this category, this sort) | `services.write`                     | `{ items, page, perPage, total, pages }` like the content list |
| **Query: table**        | You want a page of rows from one table or view with fixed filters                         | `services.write` + `services.sql`    | `{ items, page, perPage, total, pages }`                       |
| **SQL**                 | You need joins, grouping or anything a single table cannot say                            | `services.write` + `services.sql`    | `{ items }` (one object per row)                               |
| **Script**              | You need logic: call another system, combine several sources, shape a custom response     | `services.write` + `services.script` | **whatever your script returns**                               |

Prefer the lowest mode that does the job. Each step up is more powerful and so needs a more trusted person.

## Query over a table

Pick a table or view, the columns to return, optional `where` filters bound to named parameters, a sort, and the default and maximum page size. The query is built with a query builder and
**parameterised**; there is no SQL text to inject into. Column names you pick are checked against the real table. Credentials, sessions, settings, audit and platform tables are never
available here, however permissive you are.

```
GET /api/v1/services/branches?city=Pune&per_page=20&page=2
→ { "items": [ { "id": 7, "name": "Kothrud", "city": "Pune" } ], "page": 2, "perPage": 20, "total": 31, "pages": 2 }
```

## SQL mode

A read-only `SELECT` (or `WITH … SELECT`) with **named** parameters written `:name`:

```sql
SELECT b.id, b.name, b.city, COUNT(s.id) AS staff
FROM branches b
LEFT JOIN staff s ON s.branch_id = b.id
WHERE b.city = :city
GROUP BY b.id, b.name, b.city
ORDER BY b.name
```

Declare `city` as a parameter (string, number or boolean; optionally required). The value comes from the query string and is **bound**, never pasted into the SQL.

What the platform checks, and what it does not:

- Exactly **one statement**, and it must start with `SELECT` or `WITH`.
- Writes and dangerous keywords (`insert update delete drop alter create truncate grant …`, `into outfile`) are refused. Quoted text and comments are ignored when checking, so `'update requested'` is fine.
- A **statement timeout** and a **row limit** are applied (Settings → Security: `Services: SQL statement timeout`, `Services: rows returned per SQL query`).
- **This is a safety net, not a sandbox.** Anyone who can create a SQL Service can read any table the database user can, including ones with personal data. Treat `services.sql` as a trusted permission.

SQL is written for **your** database. A query using a MySQL-only function will not run on PostgreSQL. Stick to portable SQL if you may move databases.

## Script mode

A script is the body of an async function with two arguments:

```js
// req.query  → the query-string parameters, all strings
// req.locale → the language code
// ctx        → the whole platform context
const city = String(req.query.city || '').trim();
if (!city) return { items: [] };

const rows = await ctx.db('branches').where({ city }).orderBy('name').limit(50);
return { items: rows, city, generatedAt: new Date().toISOString() };
```

- **Return** the response body. There is no envelope: return `{ items }` yourself if components expect it.
- `ctx.db` is the Knex connection (works on SQLite, MySQL and PostgreSQL). `ctx.settings.get('ns.key')`, `ctx.cache`, `ctx.events.emit('name', payload)`, `ctx.publicData.get('/api/v1/…')` and
  `fetch` are also available. `ctx.require('pkg')` loads an installed npm package.
- A thrown error becomes a generic `500 script_error`; the detail goes to the server log, not to visitors. To say "nothing found", return a body the component can test (`{ items: [], found: false }`) rather than throwing.
- A **timeout** stops _waiting_ after the configured time and answers 504, but it **cannot interrupt** code that is already running. Do not write infinite loops.
- **A script has no sandbox.** It runs as the server, with full access to the database, secrets and files. Granting `services.script` is like giving someone a shell. Review every script.

### Emitting an event from a script

```js
await ctx.events.emit('order.shipped', { orderId: Number(req.query.id) });
return { ok: true };
```

Any [webhook](../administration/automation.md) whose event pattern matches (`order.*`) is delivered, signed, through the job queue.

## Using a Service from a component

```json
"api": [ { "name": "branches", "url": "/api/v1/services/branches?city={{ query.city | url_encode }}" } ]
```

```liquid
{% if api.branches.items.size > 0 %}
  <ul>{% for b in api.branches.items %}<li>{{ b.name }}</li>{% endfor %}</ul>
{% else %}
  <p>{{ 'branches.none' | t: 'No branches found.' }}</p>
{% endif %}
```

If the page declares `uses:`, include `services` and, to limit which ones, `uses_services: branches`.

## Calling a Service from outside

With **Public content API** on and the Service marked public:

```bash
curl 'https://example.com/api/v1/services/branches?city=Pune'
curl -H 'Authorization: Bearer cms_…' 'https://example.com/api/v1/services/branches'     # with an API key
```

Answers of a keyed request are never cached by a shared cache. The `access: customer` option is stored but does nothing until customer accounts exist.

## Scheduling a Service

**Automation → Scheduler** can run a Service on an interval or cron expression. Use a script Service that does the work (refresh a table, send a summary).

## Testing

1. Use the **Preview** panel in the editor with example parameters.
2. Check the result shape against what the component prints.
3. Try a missing, empty and hostile parameter (`'; drop table x; --`). A parameterised Service treats it as plain text.
4. Time it on realistic data. Add an index (System → Database) before raising the row limit.

## Import and export

Services export as a zip and import as an upsert (by slug). Importing a SQL or script Service needs `services.sql` or `services.script`, just like creating one by hand.

## Which to choose: a short guide

| Need                                                     | Use                             |
| -------------------------------------------------------- | ------------------------------- |
| "The five latest events"                                 | Query over the content type     |
| "Rows of my `branches` table for a city"                 | Query over the table            |
| "Orders with their customer, grouped by month"           | SQL                             |
| "Fetch a rate from another API and cache it for an hour" | Script                          |
| "Whatever the AI built for a plugin"                     | Review it as you would any code |
