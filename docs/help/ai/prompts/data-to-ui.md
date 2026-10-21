---
section: prompts
title: Show a Service's data on a page
category: Data and Services
summary: Connect an existing Service to a component and a page.
where: The assistant
tags: service, component, list, filter, paging
order: 170
---

Show the Service [[slug]] on the page [[/address]].
Create (or reuse) a component that declares the Service in its api block, passes the query-string filters [[names]] through url_encode, prints the items as [[cards / table / list]] showing [[fields]],
has an empty state, and pages with the existing pagination component.
If the data can change without anyone editing the CMS, tell me whether the page needs cache: false and why. Preview it at 375 px and desktop widths.
