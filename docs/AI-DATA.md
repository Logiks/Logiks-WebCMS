# AI & data: what each task sends, and where

Every AI call goes through one gateway (`ctx.aigov`). Under **Settings → AI & data** an administrator decides which model answers which task.
This page is the data statement: keep it, `src/modules/aigov/statement.js` and the page in step whenever a task sends something new.

## How routing works

- **Nothing is routed until you do it.** Every task uses Claude exactly as set under Settings → AI.
- A task's route is a list: _first try_, then _if that fails_. If the first model errors, times out, or its answer fails the task's check, the next one is tried.
- **The fallback receives the same request.** A route of "local model, then Claude" can send Claude the same text the local model already saw. Local-only is possible: leave "if that fails" empty.
- A task with a route never quietly uses the default model. If no model on its route can answer (offline, no tools support, over a cap), it stops with an error that says why.
- A routed model's own name is always used, whatever the feature asked for.
- **Send every task back to Claude** (Models tab) clears all routes at once. Profiles are kept.

## Never sent

- Environment variables, the master key, any API key or password.
- Values of secret settings, header values or request variables (the assistant sees names only).
- Evidence files, backups and database dumps; visitor data (accounts, form submissions, sessions).
- Text is masked before sending, for every model: private keys, `sk-ant-…`, `sk-…`, AWS and GitHub keys, encrypted setting values and bearer tokens become `[hidden]`.

## What each task sends

| Task                                 | Sent                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant chat                       | The chat so far (older turns summarised), attached pictures, the project requirement and quality rules, and whatever its tools read to do your request. |
| Assistant: "how do I…" answers       | Your question, the recent chat, and the Help guide text read with 3 read-only tools.                                                                    |
| Assistant: chat summaries            | The older part of the chat being summarised.                                                                                                            |
| Project Requirement rebuild          | The current requirement, a snapshot of the site, and from your last 12 chats their titles, summaries and up to 12 of your messages each.                |
| Page Designer                        | Your request and the pages, components and theme parts its tools read.                                                                                  |
| Plugin Editor                        | Your request and the plugin's own files.                                                                                                                |
| Translations                         | The strings being translated and the target language.                                                                                                   |
| SEO suggestions                      | The address, your hint, and the visible text of the live page (first 4,000 characters).                                                                 |
| Services (write it for me)           | Your description, content type and field names, and existing service slugs. Never row data.                                                             |
| Components / Pages (write it for me) | Your description, the quality rules, and names of existing components or addresses.                                                                     |

## Spending and quality

- Daily and monthly **token and cost caps** count cloud calls only; local models are never counted. Costs need your Claude prices (Settings tab).
- The **Usage** tab shows calls, success, usable answers, a quality score, tokens, cost and "saved by local models" per task and model.
  Quality uses only observed signals: failed 0, unusable 25, truncated −20, and the thumbs-up rate carries 60% once answers are rated. "Saved" counts only
  successful, usable local calls priced at your Claude prices, and is an estimate.
- `AI_DISABLED=1` in the environment switches every AI feature off. It cannot be changed from the admin on purpose.

## Adding an AI task

1. Add it to `FEATURES` in `src/modules/aigov/features.js`.
2. Call `ctx.aigov.client({ feature, injected })` (or `aigov.call`) and pass `validate` if the answer must have a shape.
3. Describe what it sends in `statement.js` and in the table above.
4. Test it with the fake local OpenAI server and fake Anthropic server in `test/aigov.test.js`: no real keys.
