---
section: support
title: Troubleshooting
summary: Symptoms, likely causes and the fix, for the problems people hit most often.
order: 10
---

# Troubleshooting

Work from the symptom. Each entry says what to check first. If the fix is not here, [report the problem](reporting-a-problem.md) with the details listed there.

## Signing in

| Symptom                                            | Likely cause and fix                                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Too many attempts" or the account is locked       | Five wrong passwords lock an account for 15 minutes. Wait, or an administrator unlocks you under Security → Users.                                                      |
| The reset email never arrives                      | Mail is not set up or failing. Check Settings → Email (_Send me a test email_), then Operations → System → Failed jobs for the `mail.send` error. Check the spam folder. |
| The reset or invitation link says it expired       | Links expire (60 minutes for resets, 72 hours for invitations by default). Ask for a new one.                                                                           |
| Sign-in works but you are signed out again at once | Cookies blocked, or the site is on plain HTTP behind a proxy that does not tell the server it is HTTPS. Ask the person running the servers to check `TRUST_PROXY_HOPS`. |
| A menu group or screen is missing                  | Your role does not have its permission. Ask an administrator. An optional module may also be switched off (Settings → Modules).                                         |
| You are the only administrator and are locked out  | On the server run `npm run cli -- user:unlock you@example.com` or `npm run cli -- user:reset-password you@example.com`. See [Maintenance](maintenance.md).              |

## The public site

| Symptom                                               | Likely cause and fix                                                                                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A page shows old content after you saved              | Browsers and CDNs may hold a page for up to 60 seconds (browser) and 5 minutes (CDN). Wait, or hard-refresh. If it is still old after 5 minutes, flush the cache (Operations → System) and report it.                 |
| An address shows "Page not found"                     | No page matches it. Check Webmaster → Site pages for a page with that address, or whether a feature (Blog, Content pages) is switched off. A new content type needs a page that shows it.                             |
| A published post does not appear in a list            | Status must be **Published** and the publish time not in the future. Check the list component's data (`per_page`, category).                                                                                          |
| The home page shows the starter banner, not your page | Set the page address in Settings → Website → Home page (default `home`). If no such content page exists the home page lists the latest posts.                                                                         |
| Everything looks unstyled                             | The theme failed to load or fell back. Look at Appearance → Themes: the live theme is shown; reinstall or switch back. The built-in theme steps in if the live one cannot render, and the server log names the error. |
| An image does not appear                              | The file was deleted from the media library, or an outside image is blocked by the content security policy. Pictures must come from your own site.                                                                    |
| A component prints nothing                            | Its data returned nothing (wrong address or filter), or its feature is off. Open it in Webmaster → Components → Preview and check the data panel.                                                                     |
| A font or script from a CDN does not load             | The site only loads from itself. Install it under System → Libraries (or _Files from a CDN_) and use the local copy. Or add the source in Settings → Security (extra sources).                                        |
| Search finds nothing                                  | Search indexes published content. Run a reindex (`npm run cli -- search:reindex`) if content was imported directly into the database.                                                                                 |

## Editing

| Symptom                                                | Likely cause and fix                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saving a page is refused                               | The message names the file and the problem: a Liquid syntax error, a forbidden tag, a missing front-matter binding, a file that is too large. Fix what it says.                                      |
| "Someone else changed this" (409)                      | Another person saved first. Copy your edit, reload, and apply it again.                                                                                                                              |
| Preview works but the live page fails                  | The preview shows your draft over the real site; the live page uses saved files. Save, then reload. Check the page's **uses** list (the modules it may read) in the editor.                          |
| A `<script>` I added to a component or page is blocked | Scripts must be plain `<script>` blocks in the page or component (they get a security nonce automatically). Inline event attributes such as `onclick=""` are blocked by the content security policy. |
| Upload fails                                           | File too large, or an unsupported type. SVG files are cleaned: if nothing is left they are refused.                                                                                                  |

## Services and data

| Symptom                                        | Likely cause and fix                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A Service returns 404 from a component         | The Service is switched off, its slug is wrong, or **Settings → All settings → Features → Services** is off.                            |
| A Service works in the admin but not over HTTP | Turn on **Public content API** and mark the Service public. API keys also need the right scope.                                         |
| SQL Service says "only SELECT statements"      | SQL mode is read-only and single-statement. Use a script Service (needs `services.script`) for anything else.                           |
| "The script did not respond in time"           | The script ran longer than Settings → Security → script timeout. It only stops _waiting_: a stuck script keeps running. Fix the script. |
| The query is slow                              | Add an index (System → Database → Indexes), return fewer columns, lower the row limit, or cache the page.                               |

## Servers and operations

| Symptom                                         | Likely cause and fix                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server shows amber in Cluster                 | It has not yet applied the latest settings. It polls and heals itself; if it stays behind, restart it.                                            |
| Server refuses to start: "pending migrations"   | Run `npm run migrate` as the deploy step, then start. Production never migrates by itself.                                                        |
| Server refuses to start: cannot decrypt secrets | `APP_MASTER_KEY` does not match the one used to save the secrets. Restore the right key (or move the old one to `APP_MASTER_KEY_OLD`).            |
| Updates screen says "Local changes"             | Someone edited files on that server. Discard or commit them before updating.                                                                      |
| Jobs pile up and nothing is sent                | No worker is running (`ROLE=worker` or `ROLE=all`), or Redis is unreachable. Check Cluster.                                                       |
| Readiness check fails (`/readyz` 503)           | The database or Redis cannot be reached, or the server is draining for a restart. This is deliberate: the load balancer stops sending it traffic. |

## The assistant and AI features

| Symptom                                     | Likely cause and fix                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| "No AI key configured"                      | Add the Anthropic key in Settings → AI. It is stored encrypted and not shown again.                                            |
| The assistant stops half way through a task | It hit a token budget (per chat, person or day; Settings → Assistant). Raise it, or continue in a new chat with a shorter ask. |
| It says it cannot change something          | It only does what **you** may do. Check your role.                                                                             |
| It built something wrong                    | System → Change history → **Revert** that entry. Then try again with a [better prompt](../ai/prompting-guide.md).              |
| Screenshots are missing                     | The server has no headless Chrome. Install Chromium on each web server; the assistant falls back to reading the pages.         |
