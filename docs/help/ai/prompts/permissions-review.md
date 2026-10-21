---
section: prompts
title: Review who can do what
category: Operations and automation
summary: A least-privilege check of roles and users.
where: The assistant (read-only)
tags: security, roles, permissions, users, audit
order: 320
---

Review Security → Users and Roles. List who holds the sensitive permissions (pages.write, components.write, themes.edit, services.sql, services.script, dbms.query, plugins.manage, prompts.write, modules.manage, system.update),
users who have not signed in for 90 days, and accounts with the Administrator role. Suggest for each the smallest role that still lets them do their job. Change nothing.
