---
section: administration
title: Automation, analytics and testing
summary: React to events with webhooks, run work on a schedule, check the whole site automatically and read traffic.
order: 70
---

# Automation, analytics and testing

## Events

Something happening on the site is an **event**: `content.published`, `content.updated`, `content.deleted`, `user.created`, `contact.submitted`. **Logs → Events**
lists what was recorded. There is no fixed list: a script Service can emit any event name of its own.

## Webhooks

**Automation → Webhooks** sends a signed HTTP request to another system when an event happens.

1. **New webhook**: give it a name and the URL to call.
2. **Event**: an exact name (`content.published`) or a pattern: `content.*` matches one level (`content.published`), `**` matches any depth.
3. **Secret** (optional, write-only): used to sign each delivery. The receiver checks the `X-CMS-Signature` header.
4. **Payload** (optional JSON) is merged under the event's own data; the event's fields win. **Send test** sends it.
5. **Deliveries** shows each attempt, the response and any error.

A webhook URL is trusted like an administrator's: it can point anywhere the server can reach. Only people you trust should hold `webhooks.write`.

## Scheduler

**Automation → Scheduler** runs a **Service** or fires a **Webhook** repeatedly.

- Choose an **interval** (at least one minute) or a **cron expression**. The editor previews the next run times.
- Tasks run once per schedule across the whole cluster, not once per server.
- **Run now** tries a task immediately. Changes take effect straight away; nothing needs a restart.

Typical uses: refresh a feed into a table every hour, ping an uptime monitor, send a nightly summary.

## AI Testing

**Automation → AI Testing** crawls your public pages (from the sitemap) and reports problems at phone, tablet and desktop widths: layout and overflow, contrast and other
accessibility problems, SEO (titles, descriptions, headings, canonical, noindex versus sitemap), placeholder text, spelling, console errors and blocked requests, broken
internal links, redirects, forms, security headers and more.

- Each run is compared with the previous one: new, fixed and still-open problems.
- **Fix with the assistant** hands a finding to the assistant with its context.
- Reports export as CSV or PDF; you can schedule a nightly or weekly run and set alert thresholds.
- Without a headless browser on the server the checks that need one (layout, contrast, pictures) are skipped and the report says so. The text-only checks still run.

## Analytics

**Analytics** shows the public site's visitors and, separately, use of the admin.

- **Overview**: visitors, page views, pages per visitor, a daily trend, devices and top referrers.
- **Active Now**: who is on the site in the last few minutes, by page.
- **Page Analytics**, **Sessions** and **User-wise**: popular pages, individual visits, and behaviour.

Page views are counted on the server, so ad blockers and visitors without JavaScript still count. A small script adds clicks on anything marked `data-track` and time on page.
"Active now" is approximate: a visitor who reads without clicking drops off after the window.
