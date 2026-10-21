---
section: prompts
title: Connect an event to another system
category: Operations and automation
summary: Design a webhook and its payload.
where: The assistant, then Automation → Webhooks
tags: webhook, event, integration, crm
order: 300
---

When [[event, e.g. content.published or contact.submitted]] happens I want [[system]] to be told.
Propose the webhook: the event pattern, the JSON payload fields the other system needs, how the receiver should verify the X-CMS-Signature header, and what to do when delivery fails.
Show a sample payload and a small receiver in [[Node / PHP / Python]] that verifies the signature. Do not create anything yet; I will enter the secret myself.
