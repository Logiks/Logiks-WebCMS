---
section: coding
title: CSS, JavaScript and libraries
summary: Where styles and scripts go, the content security policy that limits them, and how to bring in third-party code safely.
order: 60
---

# CSS, JavaScript and libraries

## Where CSS goes

| Level          | Where                                                                  | Reaches                                      |
| -------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| The whole site | The theme's `styles/*.css`, or **Appearance → Customize → custom CSS** | every page                                   |
| One component  | The component's `<style>`                                              | that component only (scoped)                 |
| One page       | The page's **Style** tab                                               | that page                                    |
| A library      | **System → Libraries** (stylesheet from an npm package)                | every page, or the pages that ask for a file |

The order in `<head>` is: libraries, the theme's styles, the components' CSS, then **custom CSS last**, so custom CSS wins.

### Design tokens

Put colours, spacing and fonts in CSS variables on `:root` in the theme, and use only those in components:

```css
:root {
  --ink: #14212a;
  --muted: #5d7076;
  --line: #dde3e1;
  --bg: #ffffff;
  --soft: #f4f7f6;
  --accent: #2b59c3;
  --radius: 10px;
  --space: 1rem;
}
```

Switching the theme then restyles every component without touching them.

## JavaScript

JavaScript can live in:

- a **component's `<script>`** or a **page's Scripts tab** (anyone with the permission to write that page can add one; it runs for every visitor);
- a **theme's `scripts/*.js`**, which are **refused in installed themes** unless Settings → Themes allows JavaScript (a theme script runs on the same address as the admin, so only allow it for themes
  you trust with your own admin session);
- a **library** that you install (scripts from libraries are off until you allow them in Settings → Libraries).

Write a plain `<script>`; the platform adds a per-render nonce. Example:

```html
<button type="button" class="more" data-target="#extra">Show more</button>
<div id="extra" hidden>…</div>
<script>
  document.querySelectorAll('.more').forEach((b) =>
    b.addEventListener('click', () => {
      const el = document.querySelector(b.dataset.target);
      el.hidden = !el.hidden;
      b.setAttribute('aria-expanded', String(!el.hidden));
    }),
  );
</script>
```

## The content security policy (why something does not load)

The public site tells browsers to load scripts, styles, fonts, images and connections **from its own address only**, plus the per-render nonce for inline scripts. So:

| You wrote                                         | What happens | Do instead                                                                                                                                                                        |
| ------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<script src="https://cdn.example.com/x.js">`     | blocked      | Install the package under System → Libraries and use `library_url`                                                                                                                |
| `<link href="https://fonts.googleapis.com/…">`    | blocked      | Libraries → _Files from a CDN_ copies the stylesheet and its fonts onto your site                                                                                                 |
| `<img src="https://other.site/pic.jpg">`          | blocked      | Upload it to the media library                                                                                                                                                    |
| `onclick="doThing()"`                             | blocked      | `addEventListener` in a `<script>`                                                                                                                                                |
| `fetch('https://api.other.com/…')` in the browser | blocked      | Call it from a script **Service** on the server and fetch your own `/api/v1/services/…`; or add the origin under Settings → Security → "Extra connect sources" if you accept that |

Opening the policy up is possible (Settings → Security has "Extra … sources") but every addition is a place visitors' data can go. Prefer copying the file onto your site.

## Libraries

**System → Libraries** installs an npm package and serves it from `/lib/<name>@<version>/…`.

```liquid
<link rel="stylesheet" href="{{ '@fortawesome/fontawesome-free/css/all.min.css' | library_url }}">
```

`library_url` prints an empty string when the library is not installed, so a missing library degrades quietly. A library set to **Load on every page** needs no tag. The package is checked against its
published integrity hash, and a list export refuses a package whose hash changed.

## Images

- Upload through the media library; use `featuredImage.src` and `srcset` from entries.
- Set `width` and `height` (or `aspect-ratio`) to avoid layout shift.
- Use `loading="lazy"` for images below the first screen.
- SVG uploads are cleaned of scripts and external references.

## Performance habits

- Keep scripts small and `defer`red; avoid blocking the first paint.
- A page is cached by the platform; avoid `cache: false` unless the page really needs it.
- One font family for headings and one for body, at most.
- Check with **Automation → AI Testing** (it includes speed, keyboard and visual-change checks when a browser is available).
