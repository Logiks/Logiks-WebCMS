---
section: prompts
title: A read-only SQL Service
category: Data and Services
summary: A joined or grouped result for a component, with bound parameters.
where: Webmaster → Services → SQL (needs services.sql)
tags: sql, report, join, group by, parameters
order: 150
---

I need a SQL Service named [[slug]] that answers: [[the question in plain words]].
Tables and columns involved: [[table(s) and columns]].
Parameters: [[name, type, required?]]. Write it as one SELECT using named :parameters, portable across SQLite, MySQL and PostgreSQL (no engine-specific functions), with an ORDER BY and a sensible row limit.
Explain what each part does and which index would make it fast. I will create and test it myself.
