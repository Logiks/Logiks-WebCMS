---
section: ai
title: Prompting guide
summary: How to ask the assistant for what you want: a simple formula, good and poor examples, and habits that save time.
order: 20
---

# Prompting guide

A prompt is the message you type to the assistant or the Page Designer. The difference between a disappointing result and a good one is almost always the prompt.

## The formula

Say **who it is for**, **what it should do**, **what it must contain**, **what to avoid**, and **how you will judge it**.

> Build an **About** page for **a family-run furniture workshop in Pune** (visitors are homeowners comparing makers). It must **tell our story in three short paragraphs, show the team of four with photos,
> and end with a "Visit the workshop" button to /contact**. **Warm, plain tone; no stock phrases like "passionate about quality"; no invented awards.** It is done when **it reads well at 375 px wide,
> every image has alt text, and the page has a title and description**.

| Part                | Question it answers                     | Example                                                                    |
| ------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| **Audience & goal** | Who reads it, what should they do next? | "Homeowners comparing makers; the goal is a visit or call."                |
| **Content**         | What must be on it?                     | "Story, team, one testimonial I will paste, a visit button."               |
| **Constraints**     | What must hold?                         | "Use existing components; no new libraries; languages: English and Hindi." |
| **Avoid**           | What would spoil it?                    | "No lorem ipsum, no invented numbers, no stock-photo clichés."             |
| **Done when**       | How will you check it?                  | "Mobile-friendly, accessible, SEO title and description set."              |

You do not need all five every time. A small change needs one sentence; a whole site needs all of them.

## Size the request

- **Small** ("make the hero button orange", "fix the typo in the footer"): just say it. The assistant does it and validates.
- **Build-sized** (a new site, a shop, several pages): expect questions and a plan. Answer in one reply, or say **"go with your defaults"**. Approve the plan before it builds.

Splitting a big job into steps ("first the structure and navigation, then the home page, then the blog") gives you review points and costs less than one giant request.

## Good and poor, side by side

| Poor                           | Better                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Make a nice website"          | "A site for a 12-seat dental clinic in Leeds. Visitors book a check-up by phone or form. Calm, trustworthy, blue-green. Pages: Home, Treatments, Team, Prices, Contact." |
| "Fix the page"                 | "On /pricing the third card overflows on a phone. Make the cards stack under 640 px."                                                                                    |
| "Add SEO"                      | "Write a title (under 60 characters) and meta description (under 155) for each page under /services, in plain language, using the page's own content."                   |
| "Show my products"             | "Make a Service over the `products` table returning name, price and image, 12 per page, filtered by `?category=`; then a product grid component that uses it."           |
| "Make it look like stripe.com" | "Study stripe.com for structure and tone: a hero with one action, a three-step explainer, a logo row. Do not copy text or images. Use our colours."                      |

## Give it the real material

The AI cannot know your opening hours, prices, team or legal text. Paste them, or point to the **Requirements** document. If you do not, it will use clearly marked sample content and list it
at the end, so nothing fake goes live by accident. Check that list.

## Point at things precisely

Use the names the admin uses and the addresses on the site:

- "In **Webmaster → Components**, the `hero` component…"
- "The page at `/blog/[slug]`…"
- "The **Services** table `branches`, column `city`…"
- Or pin the chat to a page, component or plugin with its **Ask the assistant** button, and it will focus on that.

## Ask for the check, not just the change

End a request with how it should verify:

- "Validate the site and show me the home page on mobile."
- "Look at the screenshot and fix anything cramped, cut off or low-contrast before you report."
- "List every place you used placeholder text."

## Iterate in small steps

1. Look at the result.
2. Say **what is wrong and why**, not just "not good": "The heading and the paragraph are too close; the page feels cramped. Add more space between sections and limit the text width."
3. One topic per message. Too many changes at once make it hard to see which one broke something.

If a change went the wrong way, **Revert** it in System → Change history and rephrase, rather than asking the AI to undo its own work.

## Teach it once

- Lasting facts (brand colours, voice, banned phrases, audience) belong in **System → Requirements**.
- House rules for how it works belong in **System → Prompts** (edit the master prompt or the project type).
- Choose the right **project type** in Settings → General so it asks the questions that matter for your kind of site.

## Habits that waste money or time

| Habit                                  | Why it hurts                                               | Do instead                                                    |
| -------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| One enormous chat for everything       | Every turn carries the history                             | New chat per topic                                            |
| Pasting whole files                    | Slow and expensive; the assistant can read the file itself | Name the page or component                                    |
| Vague words ("modern", "clean", "pop") | It guesses                                                 | Give one reference, a palette, or a feeling plus a constraint |
| Asking for "everything" at once        | Quality drops as scope grows                               | Page by page                                                  |
| Accepting a claim of "done" unseen     | It may have missed something                               | Ask for a screenshot or the validation result                 |
| Pasting secrets                        | They go to the AI provider                                 | Describe the integration; add the key in Settings yourself    |

## Reviewing what it made

1. Open the pages it listed, on a phone-width window and a desktop.
2. Read all the copy. Is any fact invented?
3. Click every link and submit every form.
4. Run **AI Testing** on the new pages.
5. Look at **Change history** to see exactly which files changed.

For prompts to copy and adapt, see the [prompt library](prompt-library.md). For how to word requests that involve code, data and components, see [Prompting for code and data](prompting-for-code.md).
