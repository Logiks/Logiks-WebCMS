---
section: prompts
title: Plan a scheduled task
category: Operations and automation
summary: Work that should run on a timer, built as a Service plus Scheduler entry.
where: The assistant, then Automation → Scheduler
tags: scheduler, cron, job, recurring
order: 310
---

I need [[what should happen]] to run [[how often]]. Suggest the simplest way using a Service and Automation → Scheduler: the Service type, the exact steps it performs, the interval or cron expression
(and the next three run times), how it fails safely if the outside system is down, and how a page will read the stored result so visitors never wait on the outside system.
