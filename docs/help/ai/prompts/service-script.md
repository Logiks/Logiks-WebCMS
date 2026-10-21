---
section: prompts
title: A script Service
category: Data and Services
summary: Logic that a query cannot express, written safely.
where: Webmaster → Services → Script (needs services.script)
tags: script, api, fetch, logic
order: 160
---

Write the body of a script Service (async function with req and ctx) that: [[what it should do]].
Use ctx.db (Knex) for the database and the global fetch for any outside call, with a timeout on every outside call.
Read inputs only from req.query and validate them; never build SQL by concatenation. Return a plain object that a component can print: { items: [...] } or [[shape]].
Never log or return a secret. If nothing is found return an empty result instead of throwing. Explain every step briefly, and list what could go wrong.
