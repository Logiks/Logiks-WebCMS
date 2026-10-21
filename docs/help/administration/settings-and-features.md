---
section: administration
title: Settings, features, modules and plugins
summary: Where configuration lives, how to switch whole subsystems on and off, and how plugins fit in.
order: 60
---

# Settings, features, modules and plugins

## Settings

Almost everything you might want to change is a **setting**, stored in the database and edited in the admin, not in files. **Settings → All settings** groups them (General, Security,
Mail, SEO, Themes, AI, Libraries and so on). Changes reach every server within seconds.

- A field marked as a secret (SMTP password, API keys) can be replaced but never read back.
- Only the few things needed before the database is reachable are environment variables: the database address, Redis, the master key, port and role. Everything else is a setting.
- A setting can be pinned from the server with an environment variable named `CFG__<group>__<key>` (for example `CFG__general__maintenance_mode=true`). A pinned setting is read-only in the admin.
- **Maintenance mode** (General) shows visitors a message while you work; admins can still sign in.
- The **Search** box (`Ctrl+K`) finds any individual setting by what it does.

## Features

**Settings → Features** switches whole subsystems on and off, such as the **Blog** and **Content pages**. Each shows what you will notice when you turn it on or off.

- Switching a feature **off never deletes anything**. Content and data are kept, its pages stop being served and its menu entries disappear.
- Some features (online store, payments, customer accounts, support tickets) are listed but not available yet.

A few simple switches live in **All settings → Features**: Multiple languages, Public content API, Services.

## Modules

**Settings → Modules** lists every built-in part of the platform (grouped by category), what it needs and whether it is on.

- A module marked optional can be switched off: its screens, public API operations, menu entries and background work stop. Its data is kept.
- A core module cannot be switched off, and a module cannot be switched off while another one that is on needs it.

## Plugins

**Settings → Plugin Manager** installs, enables and removes plugins: add-ons with their own screens, permissions, settings and (optionally) front-end components.

- Install from a `.zip` (stored in the database, so every server gets it) or let a developer put a folder in `plugins/` on the server.
- **Enabling a plugin needs no restart** and it appears in the **Applications** menu. Disabling hides it.
- **A plugin is code that runs on your server.** Install only plugins you trust, exactly as you would install software. **Enable** is the trust decision.
- A plugin can have its own **Configure** button for its settings.
- **Plugin Editor** (a button in Plugin Manager) lets the AI create or edit a plugin. Review the result before you enable it.

Three plugins ship as examples: a file manager, an IP viewer and a weather demo.

## API keys

**System → API** creates keys for programs that read (or, with a write scope, create drafts in) your content over `/api/v1`. A key is shown once, can be limited to some modules,
has its own request budget and optional expiry, and can be disabled or rotated at any time. The same screen shows the generated API reference.
See [the public API](../coding/public-api.md).
