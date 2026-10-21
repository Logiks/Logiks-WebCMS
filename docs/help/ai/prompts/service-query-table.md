---
section: prompts
title: A Service over one of my tables
category: Data and Services
summary: Expose a table safely to the site as a paged list.
where: Webmaster → Services (needs services.sql), or the assistant
tags: service, table, query, database, list
order: 140
---

Create a Service named [[slug]]: a Query over the table [[table]] returning the columns [[columns]],
with these optional filters: [[column = :param, ...]], sorted by [[column and direction]], [[20]] per page and a maximum of [[50]].
Leave it disabled so I can test it. Then tell me the exact address a component should call, with an example response.
