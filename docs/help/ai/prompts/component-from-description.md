---
section: prompts
title: Create a reusable component
category: Components
summary: Describe a component completely so it works first time.
where: Webmaster → Components → New component, or the assistant
tags: component, props, template, css
order: 110
---

Create a component named [[name]].
Purpose: [[what it shows and where it is used]].
Props: [[prop names, types, defaults]].
Data: it reads [[the endpoint, e.g. /api/v1/content/post?per_page=3]] and each item has [[fields]]. Show an empty state: "[[empty message]]".
Rules for this platform: Liquid template with auto-escaped output; declare the data in the meta "api" block and url_encode anything you insert; every visible word through {{ 'key' | t: 'English' }};
scoped <style> using the theme's CSS variables with fallbacks (--ink, --muted, --line, --bg, --soft, --accent); no scripts unless needed; no external files; works at 375 px wide; visible focus; alt text from the data.
Validate it, show the preview, and tell me which props I can change.
