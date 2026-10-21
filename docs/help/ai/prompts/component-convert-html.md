---
section: prompts
title: Turn pasted HTML into a component
category: Components
summary: Convert a design snippet into a clean, themeable, translatable component.
where: The assistant, or Components → Import snippet
tags: import, html, convert, tailwind, snippet
order: 120
---

Turn the following HTML into a component named [[name]].
Keep the look, but: replace fixed colours with the theme's CSS variables (with the original value as the fallback); replace text with props that have the current text as default; wrap visible words in the t filter;
remove any external script, font, stylesheet or image and tell me what you removed; make it responsive at 375 px; use semantic elements.

[[Paste the HTML here]]
