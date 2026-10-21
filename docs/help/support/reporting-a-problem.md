---
section: support
title: Reporting a problem
summary: What to collect so a problem can be fixed in one round trip, for support staff and for you.
icon: bi-flag
order: 30
---

# Reporting a problem

A report that can be acted on the first time saves everyone a day. Collect the following, then send it to whoever supports your installation.

## The checklist

1. **What you did, step by step.** "I opened Webmaster → Site pages → About, changed the title and pressed Save."
2. **What you expected** and **what happened instead.** Copy the exact message. Messages say what is wrong and how to fix it.
3. **Where**: the address in the browser bar, the screen name, and (for the public site) the page address.
4. **When**: the date, time and your timezone. This is how the logs are searched.
5. **Who**: your account email and role. A permission problem looks different from a bug.
6. **A screenshot** of the whole window, including the address bar. For a layout problem, add the device or window width.
7. **How often**: every time, or sometimes? Does it happen to others? Does it happen in a private window?
8. **What changed recently**: a plugin enabled, an update, a theme switch, a new import. Logs → Audit log shows this.

## Where the evidence is

| Evidence                          | Where                                                                   |
| --------------------------------- | ----------------------------------------------------------------------- |
| Who changed what and when         | Logs → Audit log (filter by date and person; export CSV for the report) |
| Content changes                   | Logs → Activity                                                         |
| Changes the assistant made        | System → Change history (each entry has a diff and can be reverted)     |
| Background work that failed       | Operations → System → Failed jobs                                       |
| Server health and versions        | Operations → Cluster                                                    |
| Website problems found by a crawl | Automation → AI Testing, with the run's date                            |
| Webhook delivery attempts         | Automation → Webhooks → Deliveries                                      |

## For a developer or the server operator

Add:

- The **version**: Operations → Cluster shows each server's commit.
- The **server log** lines around the time (the logs are JSON; the request id ties a request to its errors).
- The **browser console** output (open the developer tools, Console tab) for anything that happens on screen.
- For a render problem, the **page source** and the **Preview** result of the page in Webmaster → Site pages.
- For database trouble, which database and version (SQLite, MySQL 8.4, PostgreSQL 16) the site uses.

## Never include

Passwords, API keys, tokens, the master key or the contents of `.env`. Support never needs them. If a secret was exposed in a report, rotate it.

## Urgent problems

If the public site is down or showing wrong information to visitors: switch on **maintenance mode** (Settings → General) if that is safer than leaving it up, then tell your administrator
immediately with the checklist above. Do not repeatedly restart servers: it destroys the evidence.
