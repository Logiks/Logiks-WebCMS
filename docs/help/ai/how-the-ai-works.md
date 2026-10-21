---
section: ai
title: How the AI works here
summary: The assistant, the page designer and the one-shot writers: what each can do, what steers them, and what keeps them safe.
order: 10
---

# How the AI works here

AI in this CMS is not one feature but several, sharing one key and one set of rules. Knowing which does what makes it much easier to ask for the right thing.

## Setting it up

1. **Settings → AI**: paste your Anthropic API key (stored encrypted, never shown again) and choose a model. Use _Test connection_ to check it.
2. Image generation uses its own keys (Settings → Media Generator); web search uses a Brave key (Settings → AI Research).
3. **Settings → Assistant** sets token budgets (per chat, per person, per day), the summary model and the optional git copy of the change history.

The AI runs **as the signed-in person**. Every tool it uses checks that person's permissions. If you cannot edit pages, neither can the assistant acting for you.

## The tools

| Tool                               | Where                                | What it is for                                                                                                                                                      |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Assistant**                      | the round button at the bottom right | A docked chat that can look at the site and change pages, components, translations, theme files, menus, SEO rules, services, plugins and the requirements document. |
| **AI Page Designer**               | Webmaster → AI Page Designer         | Plans and builds a **complete** page: components, images, even a table and Service (with your approval).                                                            |
| **New component / page / service** | Their "New" buttons                  | One-shot: you describe it, the AI writes, validates and saves it, and the editor opens on the result.                                                               |
| **Suggest with AI**                | SEO Manager                          | Fills an SEO rule form for you to check. Nothing is saved until you save.                                                                                           |
| **Translate with AI**              | System → Translations                | Fills or refreshes a language. Lines are marked _AI_ until a person has checked them.                                                                               |
| **AI Research**                    | Content → AI Research                | Searches the web, reads pages and keeps findings with their source links.                                                                                           |
| **Media Generator**                | Media Manager → Media Generator      | Makes an image; saves it to the library only when you choose.                                                                                                       |
| **Plugin Editor**                  | Settings → Plugin Manager            | Writes plugin files, validating each one. You decide whether to enable the result.                                                                                  |
| **AI Testing**                     | Automation → AI Testing              | Finds problems; **Fix with the assistant** hands one to the chat.                                                                                                   |

## What steers the AI (so you do not repeat yourself)

Every request to the assistant and the Page Designer carries standing instructions you can read and edit under **System → Prompts**:

1. **The master prompt**: a quality bar for every site: purpose before layout, a deliberate design direction, real content, everything works, responsive and accessible, fast and self-contained (no CDN), reuse before you build, finish what you start, be honest about what is placeholder.
2. **A working method** (Settings → AI behaviour → _Before building_):
   - _Ask when unclear_ (default): small changes are just done; a build-sized request is clarified once, assumptions are stated, a plan is shown and confirmed, then built, checked and reported.
   - _Always confirm_: state a plan and wait for a yes before changing anything.
   - _Never ask_: make sensible assumptions and build.
3. **A project type** (Settings → General → Project type): what "good" means for your kind of site (online shop, portfolio, restaurant, school and so on), including what to ask and what to avoid.

**System → Prompts** also has _See exactly what the assistant is told_, which shows the combined text for a project type. Edit a prompt to teach the AI your house rules (your brand voice, words to avoid, the sections every
page needs). _Reset to shipped text_ undoes an edit.

**System → Requirements** is a document the assistant reads and keeps: your brief, decisions, brand notes, reference sites. Anything written there is remembered for every later chat, so put lasting facts there instead of repeating them
in each conversation.

## How a build-sized request proceeds

1. **Understands**: reads the site map, existing components and the requirements; studies any reference site you gave (palette, type, layout, outline, never copying text or images).
2. **Asks once**: at most seven questions in one message, each with a default, so "go with your defaults" works.
3. **States assumptions** and **proposes a plan** you can approve, change or reject. Until you approve, writes that would change four or more documents are refused (every change under _Always confirm_).
4. **Builds completely**: design tokens and shared components first, then pages, navigation, forms and data, then SEO, translations and the 404.
5. **Checks itself**: validates the site and, where the server has a headless browser, looks at screenshots of key pages on desktop and mobile, then fixes what it sees.
6. **Reports**: what exists, what is placeholder, what only you can supply.

## It reads these guides

For "how do I…" questions the assistant searches the Help guides and the prompt library (the `search_help` and `read_help` tools) and answers from them, with a link to the guide. If the guides do not cover something it should say so. Because it reads the same files you do, keeping a guide accurate keeps its answers accurate.

## Safety nets

- **Every change is recorded**, one entry per turn, with a diff, under **System → Change history**. **Revert** puts back only the documents that are still as that change left them.
- Changes are **live immediately**; the history is how you get back, not a draft step. Use the plan approval for anything large.
- The AI is never given `services.sql`, `services.script` or `dbms.query` for the page designer: a page that needs raw SQL or a script stays a human task.
- A new component or table is **proposed** and waits for your approval before it is created.
- It knows the site's content security policy: it will not link a CDN, and it installs libraries and fonts onto your site instead.
- It states what it could not do or only guessed. Treat any claim of "tested" with the screenshot or the validation result as evidence.

## Costs and limits

- Pick a smaller model for routine edits (the picker beside _Send_) and a larger one for building a whole site.
- Start a **new chat** when the topic changes: long chats cost more, though older turns are folded into a short summary.
- Attach pictures only when they help; they are shrunk and sent for that turn only.
- Budgets stop a runaway chat. If you hit one, the message says which.

## What it cannot do

It cannot see your private files, run arbitrary commands on your server, enable a plugin for you, change what you are not allowed to change, or guarantee that the result is right. **You** review the result.
Do not paste passwords, API keys or customer data into a chat.

Next: [Prompting guide](prompting-guide.md) and the [Prompt library](../ai/prompt-library.md).
