---
section: support
title: Frequently asked questions
summary: Quick answers to the questions asked most often.
layout: accordion
icon: bi-question-circle
order: 20
---

# Frequently asked questions

## Content and the site

**Why did my change not appear straight away?**
Pages are cached for speed. Editing a piece of content refreshes exactly the pages that show it within moments; browsers keep a page up to 60 seconds and a CDN up to 5 minutes.
Edits to the site structure (pages, components, SEO rules, theme) refresh every page.

**Can I schedule a post?**
Yes: set the status to **Scheduled** and choose the time.

**I changed the theme and my pages did not change.**
Pages and content belong to the site, not the theme. A new theme changes only the frame (header, footer, fonts and colours). Components that use the theme's colour variables restyle automatically.

**Where do I change the wording of "Read more" or "Older posts"?**
System → Translations. Pick the language and edit that line. Only your edits are stored.

**How do I make a page that is not in the menu?**
Create it (Content pages or Webmaster → Site pages) and do not add it to a menu. Set _noindex_ in its SEO section to keep it away from search engines, and untick the sitemap.

**How do I redirect an old address?**
System → Redirects. Use 301 for a permanent move.

**Can I run more than one site?**
One installation serves one site. Install another copy for another site.

## Pages, components, data

**What is the difference between Content pages and Site pages?**
_Content pages_ (Content menu) are documents editors write with the block editor. _Site pages_ (Webmaster menu) are the templates that decide what each address shows, including how content pages are laid out.

**Can editors build pages without code?**
Yes: Webmaster → Site pages → Compose adds components and fills in their fields.

**How do I show a list of things from my own database table?**
Make a Service over the table (Webmaster → Services, Query mode, table source) or write a SQL Service, then read it from a component. See [Getting data into the page](../coding/getting-data-into-pages.md).

**Can a page run JavaScript?**
Yes: a page or component may carry its own `<script>`. Anyone who can write pages can do this, so grant that permission carefully.

**Can I use a font or library from a CDN?**
Not directly: the site only loads from itself. Install it under System → Libraries or use _Files from a CDN_, which copies it onto your site.

## People and security

**What is the safest way to give someone access?**
Invite them with the smallest role that works. Avoid `services.script`, `dbms.query`, `plugins.manage` and `pages.write` unless needed. See [Users and security](../administration/users-and-security.md).

**Can I see who changed something?**
Logs → Audit log (everything) and Logs → Activity (content). Both are searchable and exportable.

**Is my data encrypted?**
Secrets (mail password, API keys, webhook secrets) are encrypted at rest and never shown again after saving. Passwords are hashed. Use HTTPS on the public site.

## AI

**Does the AI see my private data?**
The assistant works through the same permissions as the person using it, and only sees what its tools return for the question at hand. Whatever it reads is sent to the AI provider for that request. Do not paste secrets into a chat.

**Can the AI break my site?**
It can change what you can change. Every change is recorded and can be reverted under System → Change history. Large changes need your approval of a plan first (unless you have turned that off).

**Why does the AI keep asking questions?**
Settings → AI behaviour → _Before building_ chooses between asking when unclear, always confirming, or never asking. See [How the AI works](../ai/how-the-ai-works.md).

**The AI cost is too high.**
Use a smaller model for routine work (the picker beside _Send_), start a new chat when a topic changes, and attach only what is needed. Budgets are under Settings → Assistant.

## Servers

**Do I need Redis?**
Not in development. In production with more than one server, yes: sessions, the message bus, rate limits and job queues use it.

**Which database should I use?**
SQLite is for development and small single-server sites. Use MySQL or PostgreSQL in production.

**How do I move from SQLite to MySQL?**
System → Database → Move database copies everything and switches the server over. Back up first.
