---
section: ai
title: Using the prompt library
summary: What the library holds, how the fill-in blanks work, and how to add prompts of your own to the docs folder.
order: 40
---

# Using the prompt library

The library is a set of ready-made prompts for the assistant, the AI Page Designer and the one-shot writers, grouped by what you are trying to do. [Open the library](#/help/prompts).

## Using a prompt

1. Pick a category or type in the filter. Search looks in the title, summary, tags and the prompt text.
2. Open a prompt. The line **Use it in** says where to paste it (usually the assistant chat).
3. Fill in the **blanks**. Each `[[Blank]]` in the prompt becomes a field above the text; what you type replaces it. Blanks you leave empty stay as `[[Blank]]` so they are easy to spot.
4. **Copy prompt**, paste it into the chat, read it once, and send.

A prompt is a starting point. Delete the parts you do not need, and add the facts only you know. The more concrete the blanks, the better the result: see the [prompting guide](prompting-guide.md).

## The categories

| Category                      | For                                                                         |
| ----------------------------- | --------------------------------------------------------------------------- |
| **Plan and brief**            | Interviewing you, planning pages before building, studying a reference site |
| **Build a site**              | Whole-site builds: a small-business site, a blog                            |
| **Pages**                     | One page at a time: landing, about, pricing, contact, FAQ                   |
| **Components**                | Creating, converting and checking reusable components                       |
| **Data and Services**         | Tables, SQL and script Services, and getting their data onto a page         |
| **Content and copy**          | Rewriting and drafting text                                                 |
| **SEO and answer engines**    | Titles, descriptions, structured data, internal links                       |
| **Design and accessibility**  | Design tokens, redesigning a section, accessibility passes                  |
| **Translation**               | Adding a language                                                           |
| **Quality and review**        | Pre-launch review, working through a test report                            |
| **Fix and debug**             | Finding the cause of a problem; understanding how something works           |
| **Operations and automation** | Webhooks, scheduled tasks, a permissions review                             |

## Add your own prompts

The library is read from the markdown files in `docs/help/ai/prompts/` on the server, so a prompt is one file and ships with your deploy like any other docs change. There is no database table to edit.

```markdown
---
section: prompts
title: Write a product description
category: Content and copy
summary: A product description in our voice, with the facts you give it.
where: The assistant
tags: product, copy, description
order: 195
---

Write a description for [[Product name]] for [[Audience]]. Use only these facts: [[Facts]].
Keep it under [[120]] words, in our voice (see the requirements document). Do not invent features.
```

- `section: prompts` is what puts the file in the library. The **file name** (lowercase, with dashes) is its id and must be unique.
- `category` groups it. Use an existing category or a new one; new ones appear automatically.
- `[[Blank]]` marks a fill-in. Keep each blank under 60 characters, on one line.
- The whole file below the front matter is the prompt exactly as copied. Write it as a message you would send, not as a document.
- `order` sorts prompts inside the library (lower first).

Guides work the same way: a markdown file in `docs/` whose front matter says `section: administration`, `support`, `coding` or `ai`, with a `title`, a `summary` and optionally an `order`, appears in Help. Files without a
`section` (such as the architecture and decision notes) are developer notes and do not show.

## Prompts that improve over time

When a prompt works unusually well, save it. When one keeps producing something you have to correct, change the prompt, not just the output: add the missing fact, the missing constraint, or the missing "avoid".
Lasting rules belong in **System → Prompts** and **System → Requirements**, where every chat picks them up.
