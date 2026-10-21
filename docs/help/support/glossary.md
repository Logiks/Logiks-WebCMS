---
section: support
title: Glossary
summary: Short definitions of the words used across the admin and these guides.
order: 50
---

# Glossary

| Term                  | Meaning                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Address / route**   | The path of a page on the site, such as `/blog/hello`.                                                                        |
| **API key**           | A secret that lets a program read (or write drafts to) your content over `/api/v1`.                                           |
| **Audit log**         | The record of who changed what, when. Secrets are never in it.                                                                |
| **Block**             | One piece of the editor: paragraph, heading, list, image, quote, code.                                                        |
| **Cache**             | A saved copy of a page or answer so it can be served quickly. Edits refresh the affected copies.                              |
| **Cluster**           | Several servers working as one site behind a load balancer.                                                                   |
| **Component**         | A reusable template with its own style and, optionally, data it reads. Pages are made of components.                          |
| **Content type**      | A kind of content with its own fields: post, content page, or one a developer adds.                                           |
| **CSP**               | Content security policy: the rule telling browsers which sources a page may load from. Here, its own address only by default. |
| **Feature**           | A subsystem you can switch on or off in Settings → Features (Blog, Content pages…).                                           |
| **Front matter**      | The block at the top of a page file between `---` lines that holds its title, layout and other options.                       |
| **Layout**            | The `<html>` frame a page is drawn in. Chosen by a page's `layout:`; belongs to the theme.                                    |
| **Liquid**            | The template language used in pages, components and themes. See the [Liquid guide](../coding/liquid-guide.md).                |
| **Locale / language** | The language of wording and content (`en`, `fr`).                                                                             |
| **Migration**         | A database change shipped with the code. Applied as a deploy step.                                                            |
| **Module**            | A built-in part of the platform with its own screens, permissions and settings.                                               |
| **Plugin**            | An add-on package that adds screens, routes, settings and components. Runs as trusted code on the server.                     |
| **Preview**           | Showing an unsaved draft without publishing it.                                                                               |
| **Prop (property)**   | A field of a component that a page fills in (heading, count, image).                                                          |
| **Role**              | A named set of permissions given to users.                                                                                    |
| **Scheduler**         | Runs a Service or webhook on an interval or cron schedule.                                                                    |
| **Service**           | A saved data question (query, SQL or script) that components and the API can use.                                             |
| **Setting**           | A value stored in the database and edited in the admin, as opposed to a file or environment variable.                         |
| **Slug**              | The URL-friendly name of a piece of content (`hello-world`).                                                                  |
| **Term**              | A category or tag.                                                                                                            |
| **Theme**             | The frame around every page: layouts, header, footer, styles, scripts, wording.                                               |
| **Webhook**           | An HTTP request the platform sends to another system when an event happens.                                                   |
