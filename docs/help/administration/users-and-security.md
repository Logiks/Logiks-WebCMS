---
section: administration
title: Users and security
summary: Invite people, give them the right role, understand lockouts, and use the audit log.
order: 50
---

# Users and security

## Users

**Security → Users** lists everyone who can sign in.

- **Invite**: enter an email and a role. The person gets a link that lets them choose a password. The link expires (Settings → Security, default 72 hours). Re-send it from the same list.
- **Disable** a user instead of deleting when someone leaves: their history stays attributed to them.
- **Unlock** a user who is locked out. By default five wrong passwords lock an account for 15 minutes (both are settings).
- Everyone can change their own name and password under **Account**.

## Roles and permissions

A role is a list of permissions. Four roles exist from the start and you can edit them or add your own under **Security → Roles and permissions**.

| Role              | Meant for                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **Administrator** | Everything. Includes permissions that are not given to any other role by default.                  |
| **Editor**        | Writes, publishes and organises content, media, menus and redirects; reads themes; reads messages. |
| **Author**        | Writes pages and posts as drafts for an editor to publish; uploads images.                         |
| **Viewer**        | Signs in and looks around; reads settings, users, roles, audit log and cluster status.             |

Permissions are named `thing.action`, for example `pages.write`. A trailing `*` grants a family (`content.*`).

### Permissions that deserve care

Some permissions let a person do things as powerful as logging in to the server. Give them to as few people as you can:

| Permission                                       | Why it is sensitive                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `pages.write`, `components.write`, `themes.edit` | Raw HTML, CSS and page scripts reach every visitor.                     |
| `services.sql`, `dbms.query`                     | Run SQL against your database.                                          |
| `services.script`                                | Runs free-form code on the server with access to everything.            |
| `plugins.manage`                                 | Installs code that runs on the server.                                  |
| `prompts.write`                                  | Changes the standing instructions an AI that can edit the site follows. |
| `modules.manage`, `system.update`                | Switches parts of the platform off, or updates and restarts servers.    |

A reasonable setup: a handful of Administrators, Editors for the content team, Authors for contributors. Create a custom role (for example "Webmaster") when someone needs pages but not SQL.

## Audit log

**Logs → Audit log** records who changed what and when: settings, users, roles, pages, themes, services and more. Filter by date or person, and export CSV or JSON.
Secrets (passwords, API keys, tokens) are never recorded in it. **Logs → Activity** is the content-focused view of the same history, for editors.

## What protects the site

- Passwords are stored with argon2 and have a minimum length (Settings → Security).
- Every change request is protected against cross-site forgery; sign-in has its own rate limit per address.
- The public site sends a strict content security policy: pages may load files from their own address only. If you need an outside source (analytics, maps), add it in Settings → Security
  (the "Extra … sources" fields) rather than weakening the policy.
- Secrets in settings (SMTP password, AI keys, webhook secrets) are encrypted, shown to nobody after saving, and replaced, not edited.

## When someone leaves

1. Disable their user.
2. Check **Logs → Audit log** for what they changed recently.
3. Rotate any API key or webhook secret they knew (System → API for keys).
