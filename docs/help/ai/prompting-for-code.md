---
section: ai
title: Prompting for code and data
summary: How to word requests for components, pages, Services, SEO and plugins so the result fits this CMS.
order: 30
---

# Prompting for code and data

When you ask for a component, page, Service or plugin, the AI writes the real thing into your site. Telling it the rules of this platform up front gives results that work first time.
The assistant already knows most of them (they are in the master prompt and its tools). Add the ones below when they matter, or when you use the one-shot writers (New component, New page, New service), which know less about your site.

## State the facts of this platform

| Fact to include                                                | Why                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| "Liquid templates, auto-escaped output"                        | Stops it writing JavaScript templating or relying on unescaped HTML |
| "Reads data through the `api` block of the component"          | Components fetch data by declaring endpoints, not by querying       |
| "Use `{{ 'key' \| t: 'English' }}` for every visible word"     | Keeps the site translatable                                         |
| "Use the theme's CSS variables with fallbacks"                 | Restyles with the theme                                             |
| "No CDN, no inline event handlers, no external images"         | The content security policy blocks them                             |
| "Scoped `<style>` inside the component"                        | Prevents styles leaking                                             |
| "Reuse existing components where they fit"                     | Avoids duplicates                                                   |
| "Must work at 375 px wide; 44 px touch targets; visible focus" | Accessibility and mobile                                            |

## A component

> Create a component `team-grid`. Props: `heading` (string, default "Our team"), `columns` (number 2–4, default 3). It reads the Service `/api/v1/services/team` (items have `name`, `role`, `photo`
> (media object with `src`, `alt`), `bio`). Show a responsive grid of cards: photo on top, name, role, a two-line bio. Empty state: "No team members yet." Use the theme's CSS variables
> (`--ink`, `--muted`, `--line`, `--accent`) with fallbacks. All visible text through the `t` filter. Scoped CSS only; no scripts. Do not invent people.

Why it works: it names the data and its shape, the props and defaults, the empty state, the style rules and one thing to avoid.

## A page

> Create the page `/services`. Title "Services", description under 155 characters. Compose it from existing components: `hero` (heading "What we do", no image), `feature-grid` (the three services I list below),
> `testimonial-strip` if it exists, and `cta` (button "Book a call" → /contact). Set `uses: content, site`. Services: 1) ... 2) ... 3) ...

For dynamic pages say the address pattern and what it shows: "Create `products/[slug]`, entry type `product`, a 404 when the slug does not exist."

## A Service

> Make a Service `branches`: a **Query** over the table `branches`, columns `id, name, city, phone`, filter `city = :city` (optional), sort by `name`, 20 per page (max 50). Leave it **disabled**; I will test it.

For SQL: "Write a read-only SQL Service … Declare parameters `from` (number, required) … Use only portable SQL (no MySQL-only functions)." For scripts: "Write a script Service that … returns `{ items }`.
Do not call external APIs without a timeout; never log secrets." Remember: the page designer and most AI helpers cannot create SQL or script Services; a person with `services.sql` or `services.script` must.

## A plugin

> In the Plugin Editor, create plugin `appointments`. A table `plugin_appointments_slots`; an admin screen listing slots with Add and Delete; a permission `appointments.manage` checked on every route; a `config`
> field `slot_minutes` (default 30); and a component `next-slots` that shows the next five free slots. Additive migration only. Explain how each file is validated.

Always review a plugin before you enable it: the write-time checks find malformed files, not wrong logic.

## SEO and structured data

> For each page under `/services/`, write an SEO rule suggestion: title under 60 characters, description under 155, no keyword stuffing. Add FAQPage structured data on `/faq` from the questions on that page. Do not change the
> page text.

## Debugging with the AI

Give it the **symptom, the place and what you already know**:

> `/blog/hello` shows an empty page, but the post is published. The page is `blog/[slug].html`. The preview in the page editor shows "Failed to lookup post in components". It started after I renamed the component.

Better still, paste the **exact error message** and say what you changed last. Ask it to find the cause before changing anything: "Explain the cause first, then fix the smallest thing."

## Ask for the reasoning

- "Explain what this component does and what data it reads."
- "List the risks of this SQL Service and how it is bounded."
- "What would break if I rename this component?"

## Review checklist for AI-written code

- [ ] Every visible string goes through `t`.
- [ ] Data comes only from the component's `api` list; the URLs `url_encode` what they insert.
- [ ] No `<script src>` or `<link href>` to another site; no inline `onclick`.
- [ ] A loop has an empty state; a missing required item is a 404.
- [ ] No secret, key or password is hard-coded or logged.
- [ ] SQL is `SELECT` only, parameterised, and has an index to match the filter.
- [ ] A script Service has a timeout on every outside call and does not loop forever.
- [ ] It validated (`validate_site` result or a clean save) and you have looked at it on a phone.

See also: [Writing components](../coding/components-guide.md), [Services in depth](../coding/services-in-depth.md) and the [prompt library](prompt-library.md).
