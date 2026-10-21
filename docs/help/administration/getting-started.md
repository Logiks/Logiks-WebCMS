---
section: administration
title: Getting started
summary: Sign in, find your way around the menu, and learn the three ways to look for anything.
order: 10
---

# Getting started

The admin is at `/admin` on your site (for example `https://example.com/admin`). Everything you can do is decided by your **role**, so you may see
fewer menu groups than this guide describes. If a screen is missing, you do not have its permission: ask an administrator.

## Signing in

1. Open `/admin` and enter your email and password.
2. After too many wrong passwords the account is locked for a while (by default 5 attempts, then 15 minutes). An administrator can unlock it under
   **Security → Users**, or you can wait.
3. **Forgot your password?** Use the link on the sign-in page. The reset email arrives within a minute or two; the link expires (60 minutes by default).
4. **New here?** An administrator invites you by email. The invitation link sets your password and expires after 72 hours by default.

Your own name and password are under **your name** at the bottom of the menu (Account).

## The menu

The menu is grouped by what you are trying to do.

| Group             | What it is for                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| **Overview**      | A dashboard: content counts, traffic, servers, recent changes. Each tile shows only if you may open it.      |
| **Webmaster**     | Build the site: **Site pages**, **Components**, **AI Page Designer**, **Services**, **SEO Manager**.         |
| **Content**       | What editors write: Posts, Content pages, Categories and tags, AI Research.                                  |
| **Media Manager** | The media library, the AI image generator and media usage.                                                   |
| **Applications**  | The screens of any plugins that are switched on.                                                             |
| **Analytics**     | Traffic, who is on the site now, popular pages, sessions.                                                    |
| **Logs**          | Audit log (who changed what), content Activity and Events.                                                   |
| **Appearance**    | Themes, Customize, Theme editor, Menus.                                                                      |
| **System**        | Requirements, Prompts, Change history, Translations, Redirects, Messages, Sitemap, Libraries, Database, API. |
| **Settings**      | All settings, Features, Plugin Manager, Modules.                                                             |
| **Security**      | Users, Roles and permissions.                                                                                |
| **Operations**    | Cluster, System (cache and jobs) and Updates.                                                                |
| **Automation**    | Webhooks, Scheduler and AI Testing.                                                                          |
| **Help**          | This section.                                                                                                |

On a phone or tablet the menu opens from the button at the top left.

## Finding things

- **Search** (press `Ctrl+K`, `⌘K` or `/`): type what you want in plain words, such as "change the logo" or "redirect".
  It finds screens, individual settings and common tasks.
- **Help search**: the box on every Help screen searches these guides and the prompt library.
- **The assistant**: the round button at the bottom right opens a chat that can look at the site and, as you, change it. See
  [How the AI works](../ai/how-the-ai-works.md).

## The words used here

| Word          | Meaning                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| **Page**      | An address on the public site. Built under Webmaster → Site pages. Every address is a page.            |
| **Content**   | Posts and Content pages that editors write. Content is data; a page decides how to show it.            |
| **Component** | A reusable piece of a page (a hero, a card list). A page is made of components.                        |
| **Theme**     | The frame around every page: header, footer, styles, fonts. Changing the theme changes only the frame. |
| **Service**   | A saved question for the database (a query, SQL or a script) that a component can use to show data.    |
| **Feature**   | A whole subsystem you can switch on or off, such as the Blog.                                          |
| **Module**    | A built-in part of the platform. Some can be switched off under Settings → Modules.                    |
| **Role**      | A named set of permissions given to users.                                                             |

More in the [glossary](../support/glossary.md).

## Your first hour

1. **Settings → All settings → General**: set the site name, tagline, public URL, timezone and default language.
2. **Settings → Email**: add your SMTP server and use _Send me a test email_. Password resets and invitations need working mail.
3. **Appearance → Themes**: pick the theme; **Customize** for colours and fonts.
4. **Appearance → Menus**: build the main and footer menus.
5. **Content**: write a first page or post; see [Content and media](content-and-media.md).
6. **Security → Users**: invite your team and give each person the smallest role that lets them do their work.
