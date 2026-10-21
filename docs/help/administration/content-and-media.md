---
section: administration
title: Content and media
summary: Write, schedule and publish content with the block editor, organise it with categories and tags, and manage pictures.
order: 20
---

# Content and media

## Content types

Content is split into **types**. Out of the box there are:

- **Content pages**: standing pages such as About, Terms and Privacy. They can be nested (a child page lives under its parent's address). Turn them on or off
  under **Settings → Features → Content pages**.
- **Posts**: dated articles for a blog or news. Turn them on or off with **Settings → Features → Blog**.

A developer can declare more types (events, products, case studies). Each appears in the **Content** menu with the permissions it needs. Content types are
not the same as **Webmaster → Site pages**: those are the templates that decide how content is shown.

## Writing and publishing

Open a type, choose **New**, and fill in the title and the content. The editor is made of **blocks**: paragraph, heading, list, quote, code, image,
delimiter and others. Add a block, write in it, drag to reorder.

A piece of content has a **status**:

| Status        | Meaning                                     |
| ------------- | ------------------------------------------- |
| **Draft**     | Only editors see it.                        |
| **Scheduled** | Goes live by itself at the time you choose. |
| **Published** | Live on the site.                           |
| **Archived**  | Kept, but not shown.                        |

- Authors can usually save drafts only; an editor publishes. This depends on the role (see [Users and security](users-and-security.md)).
- **Revisions**: every save keeps a version. Open the history and **Restore** an older one; the restore is recorded in **Logs → Activity**.
- The **address** (slug) is made from the title and can be edited. Changing it later changes the link; add a redirect (below) if people may have the old one.
- Fill in the **Summary** and the **featured image**: they feed lists, search results, and the preview when someone shares the link.

Published content appears on the site only if a page shows it. If you add a new content type and nothing appears at its address, ask a developer to add a page for it
(see [Pages, components and services](pages-components-services.md)).

## Categories and tags

**Content → Categories and tags** holds the terms you sort posts by. Give each a name; the address is made from it. Each term gets its own page on the site that lists its posts.

## Media

**Media Manager → Media Library** holds images and files.

- **Upload** by dragging files into the page, with **Upload files**, or with **Upload a folder** (its sub-folders are kept). Any number at once; a file that can't be uploaded is listed and the rest carry on. Files are checked by their contents, not their name. Images (JPEG, PNG, GIF, WebP, AVIF, SVG, TIFF, HEIC, BMP, ICO), videos (MP4, MOV, WebM, MKV, AVI and more) and documents (PDF, Word, Excel, PowerPoint, OpenDocument, RTF, text, CSV, zip) are accepted; web pages, scripts, programs and audio are not. SVG images are cleaned of anything that could run code.
- **Compression.** By default photos are re-saved without camera data (including location) and smaller sizes are made. Untick **Compress images** to keep a photo exactly as uploaded. Open such an image later and choose **Compress in place** (replaces the file) or **Save a compressed copy** (keeps both).
- **Folders.** Use **New folder**, click a folder to open it, and use **Rename** or **Delete folder** (only when empty). Pick a file's folder in its details. Moving a file never changes its address. Pictures attached in the assistant are filed in the **assistant** folder.
- **Videos** are stored as uploaded. A thumbnail and icon are made when the server has ffmpeg; open a video and use **Use this moment** to choose which frame.
- Give every image **alt text** when you insert it. Screen readers and search engines use it, and the AI Testing report flags missing ones.
- Each item shows **where it is used**. Before deleting, check that nothing still shows it.
- **Media Generator** makes an image with an AI image provider. It needs a key under Settings and nothing is saved until you choose to save it.
- **Media Analytics** lists the biggest, most used and unused files.

Keep pictures a sensible size: a 600 KB photo on every card slows the page more than anything else you can do.

## Redirects and messages

- **System → Redirects**: send an old address to a new one (301 for a permanent move, 302 for temporary). Each redirect matches one exact address.
- **System → Messages**: what visitors sent through the contact form.

## Languages

The site's fixed wording (buttons, "Read more", "Older posts") is edited under **System → Translations**. Pick a language and change only what you need; what you
leave alone keeps the shipped wording. **Translate with AI** fills a language from the default one and marks the lines _AI_ until you have checked them.
Turn on **Multiple languages** (Settings → All settings → Features) to serve each language under its own address prefix (`/fr/…`).

## Good habits

- Write the summary and alt text while you still remember what the piece is about.
- Preview before you publish (the editor has a preview) and look at it on a phone.
- Use the **Activity** log (Logs → Activity) to see who changed what when something looks wrong.
