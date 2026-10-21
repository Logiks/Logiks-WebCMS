/**
 * Startup templates for new pages: Webmaster → Site pages → Templates, and Webmaster → AI Page Designer → Templates
 * (one catalogue, served by the site module so neither screen depends on the other).
 *
 * A template is a complete, ordinary page: front matter + a body of plain HTML with one scoped <style> block at the
 * end (exactly how the page editor stores a page's own style). It is deliberately SELF-CONTAINED — no
 * {% render "…" %} of a component that some sites may not have — so every template works on every site and theme,
 * and the person can edit it afterwards in the chat, or in Webmaster → Pages once saved. Colours come from the
 * theme's own variables (`--accent`, `--line`, `--soft`, `--muted`, `--bg`) with fallbacks, so a template takes on
 * the site's look instead of bringing its own.
 *
 * Copy is placeholder wording meant to be replaced; it is plain text on purpose (no invented claims, numbers or
 * names that could be mistaken for real ones).
 */

/** Shared look. Every class is prefixed `tpl-` so it can't collide with the theme or another page's own styles. */
const BASE = `
<style>
  .tpl { color: inherit; }
  .tpl * { box-sizing: border-box; }
  .tpl-wrap { max-width: 68rem; margin: 0 auto; padding: 0 1.25rem; }
  .tpl-section { padding: 3.5rem 0; }
  .tpl-soft { background: var(--soft, #f5f7f6); border-top: 1px solid var(--line, #dde3e1); border-bottom: 1px solid var(--line, #dde3e1); }
  .tpl h1 { font-size: clamp(2rem, 5vw, 3.25rem); line-height: 1.12; letter-spacing: -0.02em; margin: 0 0 0.9rem; }
  .tpl h2 { font-size: clamp(1.5rem, 3vw, 2.1rem); line-height: 1.2; letter-spacing: -0.015em; margin: 0 0 0.6rem; }
  .tpl h3 { font-size: 1.15rem; margin: 0 0 0.4rem; }
  .tpl p { margin: 0 0 1rem; line-height: 1.6; }
  .tpl-lead { font-size: 1.2rem; color: var(--muted, #5d7076); max-width: 40rem; }
  .tpl-center { text-align: center; }
  .tpl-center .tpl-lead { margin-left: auto; margin-right: auto; }
  .tpl-eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; font-weight: 700; color: var(--accent, #2b59c3); margin: 0 0 0.6rem; }
  .tpl-btn { display: inline-block; padding: 0.7rem 1.3rem; border-radius: 8px; background: var(--accent, #2b59c3); color: #fff; text-decoration: none; font-weight: 600; border: 1px solid var(--accent, #2b59c3); }
  .tpl-btn:hover { filter: brightness(1.08); }
  .tpl-btn.ghost { background: transparent; color: var(--accent, #2b59c3); }
  .tpl-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.25rem; }
  .tpl-center .tpl-actions { justify-content: center; }
  .tpl-grid { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); margin-top: 2rem; }
  .tpl-card { border: 1px solid var(--line, #dde3e1); border-radius: 12px; padding: 1.4rem; background: var(--bg, #fff); }
  .tpl-card p:last-child { margin-bottom: 0; }
  .tpl-icon { width: 2.5rem; height: 2.5rem; border-radius: 10px; display: grid; place-items: center; background: color-mix(in srgb, var(--accent, #2b59c3) 12%, transparent); color: var(--accent, #2b59c3); font-weight: 700; margin-bottom: 0.9rem; }
  .tpl-stats { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); text-align: center; }
  .tpl-stat b { display: block; font-size: 2rem; letter-spacing: -0.02em; }
  .tpl-stat span { color: var(--muted, #5d7076); }
  .tpl-thumb { aspect-ratio: 4 / 3; border-radius: 10px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent, #2b59c3) 22%, #fff), color-mix(in srgb, var(--accent, #2b59c3) 6%, #fff)); margin-bottom: 0.9rem; }
  .tpl-avatar { width: 4.5rem; height: 4.5rem; border-radius: 50%; background: linear-gradient(135deg, color-mix(in srgb, var(--accent, #2b59c3) 30%, #fff), color-mix(in srgb, var(--accent, #2b59c3) 8%, #fff)); margin: 0 auto 0.8rem; }
  .tpl-muted { color: var(--muted, #5d7076); }
  .tpl ul.tpl-list { list-style: none; padding: 0; margin: 0 0 1.25rem; }
  .tpl ul.tpl-list li { padding: 0.35rem 0 0.35rem 1.4rem; position: relative; }
  .tpl ul.tpl-list li::before { content: "✓"; position: absolute; left: 0; color: var(--accent, #2b59c3); font-weight: 700; }
  .tpl details { border: 1px solid var(--line, #dde3e1); border-radius: 10px; padding: 0.9rem 1.1rem; margin-bottom: 0.75rem; background: var(--bg, #fff); }
  .tpl summary { cursor: pointer; font-weight: 600; }
  .tpl details p { margin: 0.7rem 0 0; }
</style>`;

/** @param {string} inner */
const page = (inner) => `<div class="tpl">\n${inner.trim()}\n</div>\n${BASE}\n`;

const three = (items) =>
  items
    .map(
      ([mark, title, text]) =>
        `      <div class="tpl-card"><div class="tpl-icon">${mark}</div><h3>${title}</h3><p class="tpl-muted">${text}</p></div>`,
    )
    .join('\n');

/**
 * @typedef {{id: string, category: string, name: string, description: string, icon: string, sections: string[],
 *   front: Record<string, string>, body: string}} PageTemplate
 * @type {PageTemplate[]}
 */
export const TEMPLATES = [
  {
    id: 'landing',
    category: 'Marketing',
    name: 'Landing page',
    description: 'A headline, what you offer, a few numbers and a clear call to action.',
    icon: 'bi-rocket-takeoff',
    sections: ['Hero', 'Features', 'Numbers', 'Call to action'],
    front: { title: 'Welcome', description: 'What we do and why it matters to you.' },
    body: page(`
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <p class="tpl-eyebrow">Your tagline</p>
  <h1>One clear promise for your visitors</h1>
  <p class="tpl-lead">Say in a sentence or two what you do and who it is for. Replace this wording with your own.</p>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Get started</a><a class="tpl-btn ghost" href="#features">Learn more</a></div>
</div></section>
<section class="tpl-section" id="features"><div class="tpl-wrap">
  <div class="tpl-center"><h2>Why choose us</h2><p class="tpl-lead">Three reasons, each in a line.</p></div>
  <div class="tpl-grid">
${three([
  [
    '1',
    'First benefit',
    'Describe the first thing you do well and what it means for the customer.',
  ],
  ['2', 'Second benefit', 'Describe the second thing. Keep it short and concrete.'],
  ['3', 'Third benefit', 'Describe the third thing. Finish with the one that closes the argument.'],
])}
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap">
  <div class="tpl-stats">
    <div class="tpl-stat"><b>00</b><span>Your first number</span></div>
    <div class="tpl-stat"><b>00</b><span>Your second number</span></div>
    <div class="tpl-stat"><b>00</b><span>Your third number</span></div>
  </div>
</div></section>
<section class="tpl-section"><div class="tpl-wrap tpl-center">
  <h2>Ready to begin?</h2>
  <p class="tpl-lead">Tell people exactly what happens when they click.</p>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Contact us</a></div>
</div></section>`),
  },
  {
    id: 'about',
    category: 'Company',
    name: 'About us',
    description: 'Your story, what you stand for, and the people behind it.',
    icon: 'bi-people',
    sections: ['Introduction', 'Our story', 'Values', 'Team'],
    front: { title: 'About us', description: 'Who we are and what we care about.' },
    body: page(`
<section class="tpl-section"><div class="tpl-wrap">
  <p class="tpl-eyebrow">About us</p>
  <h1>We are a team that cares about the details</h1>
  <p class="tpl-lead">A short introduction: who you are, where you are, and what you do for your customers.</p>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap" style="max-width:46rem">
  <h2>Our story</h2>
  <p>How it started, the problem you set out to solve, and how you got to where you are today. Two or three short paragraphs read better than one long one.</p>
  <p>Mention what has stayed the same since the beginning — that is usually what people trust.</p>
</div></section>
<section class="tpl-section"><div class="tpl-wrap">
  <div class="tpl-center"><h2>What we stand for</h2></div>
  <div class="tpl-grid">
${three([
  ['✦', 'Value one', 'A line about what this means in practice.'],
  ['✦', 'Value two', 'A line about what this means in practice.'],
  ['✦', 'Value three', 'A line about what this means in practice.'],
])}
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap">
  <div class="tpl-center"><h2>The team</h2><p class="tpl-lead">Introduce the people your visitors will deal with.</p></div>
  <div class="tpl-grid">
    <div class="tpl-card tpl-center"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p></div>
    <div class="tpl-card tpl-center"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p></div>
    <div class="tpl-card tpl-center"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p></div>
  </div>
</div></section>`),
  },
  {
    id: 'services',
    category: 'Marketing',
    name: 'Services',
    description: 'What you offer, how working with you goes, and a way to get in touch.',
    icon: 'bi-briefcase',
    sections: ['Introduction', 'Six services', 'How it works', 'Call to action'],
    front: { title: 'Services', description: 'What we can do for you.' },
    body: page(`
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <p class="tpl-eyebrow">Services</p>
  <h1>Everything we can do for you</h1>
  <p class="tpl-lead">One sentence that frames the list below and tells people how to choose.</p>
</div></section>
<section class="tpl-section"><div class="tpl-wrap">
  <div class="tpl-grid">
${three([
  ['A', 'Service one', 'What it is, who it is for and what they get.'],
  ['B', 'Service two', 'What it is, who it is for and what they get.'],
  ['C', 'Service three', 'What it is, who it is for and what they get.'],
  ['D', 'Service four', 'What it is, who it is for and what they get.'],
  ['E', 'Service five', 'What it is, who it is for and what they get.'],
  ['F', 'Service six', 'What it is, who it is for and what they get.'],
])}
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap">
  <div class="tpl-center"><h2>How it works</h2></div>
  <div class="tpl-grid">
${three([
  ['1', 'Tell us what you need', 'Describe the first step, what you ask of the customer.'],
  ['2', 'We make a plan', 'Describe the second step, what they can expect to receive.'],
  ['3', 'We deliver', 'Describe the last step and what “done” looks like.'],
])}
  </div>
</div></section>
<section class="tpl-section"><div class="tpl-wrap tpl-center">
  <h2>Let’s talk about your project</h2>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Get in touch</a></div>
</div></section>`),
  },
  {
    id: 'pricing',
    category: 'Marketing',
    name: 'Pricing',
    description: 'Three plans side by side, with the questions people always ask.',
    icon: 'bi-tags',
    sections: ['Introduction', 'Three plans', 'Questions'],
    front: { title: 'Pricing', description: 'Simple plans, clearly priced.' },
    body: page(`
<section class="tpl-section tpl-center"><div class="tpl-wrap">
  <p class="tpl-eyebrow">Pricing</p>
  <h1>Choose the plan that fits</h1>
  <p class="tpl-lead">Say what is included in every plan, and when someone should pick a bigger one.</p>
  <div class="tpl-grid" style="text-align:left;align-items:stretch">
    <div class="tpl-card"><h3>Starter</h3><p class="tpl-muted">For trying things out</p><p style="font-size:2rem;font-weight:700;margin:0.5rem 0">$0<span class="tpl-muted" style="font-size:1rem;font-weight:400"> /month</span></p>
      <ul class="tpl-list"><li>First included thing</li><li>Second included thing</li><li>Third included thing</li></ul><a class="tpl-btn ghost" href="/contact">Choose Starter</a></div>
    <div class="tpl-card" style="border-color:var(--accent,#2b59c3);box-shadow:0 8px 24px rgba(0,0,0,.08)"><h3>Standard</h3><p class="tpl-muted">Most popular</p><p style="font-size:2rem;font-weight:700;margin:0.5rem 0">$00<span class="tpl-muted" style="font-size:1rem;font-weight:400"> /month</span></p>
      <ul class="tpl-list"><li>Everything in Starter</li><li>Fourth included thing</li><li>Fifth included thing</li></ul><a class="tpl-btn" href="/contact">Choose Standard</a></div>
    <div class="tpl-card"><h3>Premium</h3><p class="tpl-muted">For larger needs</p><p style="font-size:2rem;font-weight:700;margin:0.5rem 0">$00<span class="tpl-muted" style="font-size:1rem;font-weight:400"> /month</span></p>
      <ul class="tpl-list"><li>Everything in Standard</li><li>Sixth included thing</li><li>Seventh included thing</li></ul><a class="tpl-btn ghost" href="/contact">Choose Premium</a></div>
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap" style="max-width:46rem">
  <h2>Questions</h2>
  <details><summary>Can I change plan later?</summary><p>Answer in a sentence or two.</p></details>
  <details><summary>What payment methods do you accept?</summary><p>Answer in a sentence or two.</p></details>
  <details><summary>Is there a contract?</summary><p>Answer in a sentence or two.</p></details>
</div></section>`),
  },
  {
    id: 'portfolio',
    category: 'Showcase',
    name: 'Portfolio',
    description: 'A grid of your best work, each with a title and a line about it.',
    icon: 'bi-grid-3x3-gap',
    sections: ['Introduction', 'Project grid', 'Call to action'],
    front: { title: 'Our work', description: 'A selection of recent projects.' },
    body: page(`
<section class="tpl-section"><div class="tpl-wrap">
  <p class="tpl-eyebrow">Portfolio</p>
  <h1>Selected work</h1>
  <p class="tpl-lead">A line about the kind of work you are proudest of.</p>
  <div class="tpl-grid">
    <div class="tpl-card"><div class="tpl-thumb"></div><h3>Project one</h3><p class="tpl-muted">What it was and what you did.</p></div>
    <div class="tpl-card"><div class="tpl-thumb"></div><h3>Project two</h3><p class="tpl-muted">What it was and what you did.</p></div>
    <div class="tpl-card"><div class="tpl-thumb"></div><h3>Project three</h3><p class="tpl-muted">What it was and what you did.</p></div>
    <div class="tpl-card"><div class="tpl-thumb"></div><h3>Project four</h3><p class="tpl-muted">What it was and what you did.</p></div>
    <div class="tpl-card"><div class="tpl-thumb"></div><h3>Project five</h3><p class="tpl-muted">What it was and what you did.</p></div>
    <div class="tpl-card"><div class="tpl-thumb"></div><h3>Project six</h3><p class="tpl-muted">What it was and what you did.</p></div>
  </div>
  <p class="tpl-muted" style="margin-top:1.5rem">Replace each grey block with a picture from the media library.</p>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <h2>Have a project in mind?</h2>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Start a conversation</a></div>
</div></section>`),
  },
  {
    id: 'faq',
    category: 'Content',
    name: 'FAQ',
    description: 'Common questions with answers that open and close.',
    icon: 'bi-question-circle',
    sections: ['Introduction', 'Eight questions', 'Still stuck?'],
    front: {
      title: 'Frequently asked questions',
      description: 'Quick answers to common questions.',
    },
    body: page(`
<section class="tpl-section"><div class="tpl-wrap" style="max-width:46rem">
  <p class="tpl-eyebrow">Help</p>
  <h1>Frequently asked questions</h1>
  <p class="tpl-lead">Start with the questions you get asked most often.</p>
  <div style="margin-top:2rem">
    <details open><summary>First question?</summary><p>Answer in a sentence or two. Link to a page for the long version.</p></details>
    <details><summary>Second question?</summary><p>Answer in a sentence or two.</p></details>
    <details><summary>Third question?</summary><p>Answer in a sentence or two.</p></details>
    <details><summary>Fourth question?</summary><p>Answer in a sentence or two.</p></details>
    <details><summary>Fifth question?</summary><p>Answer in a sentence or two.</p></details>
    <details><summary>Sixth question?</summary><p>Answer in a sentence or two.</p></details>
    <details><summary>Seventh question?</summary><p>Answer in a sentence or two.</p></details>
    <details><summary>Eighth question?</summary><p>Answer in a sentence or two.</p></details>
  </div>
  <div class="tpl-card tpl-center" style="margin-top:2rem"><h3>Still have a question?</h3><p class="tpl-muted">Tell people the fastest way to reach you.</p><a class="tpl-btn" href="/contact">Contact us</a></div>
</div></section>`),
  },
  {
    id: 'contact-info',
    category: 'Company',
    name: 'Contact details',
    description: 'How to reach you: address, phone, email and opening hours.',
    icon: 'bi-geo-alt',
    sections: ['Introduction', 'Address · phone · email', 'Opening hours'],
    front: { title: 'Contact us', description: 'How to reach us.' },
    body: page(`
<section class="tpl-section"><div class="tpl-wrap">
  <p class="tpl-eyebrow">Contact</p>
  <h1>We’d love to hear from you</h1>
  <p class="tpl-lead">Say how quickly you usually reply and what to include in a message.</p>
  <div class="tpl-grid">
    <div class="tpl-card"><div class="tpl-icon">@</div><h3>Email</h3><p class="tpl-muted">name@example.com</p></div>
    <div class="tpl-card"><div class="tpl-icon">☎</div><h3>Phone</h3><p class="tpl-muted">+00 000 000 0000</p></div>
    <div class="tpl-card"><div class="tpl-icon">⌖</div><h3>Address</h3><p class="tpl-muted">Street, City<br>Country</p></div>
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap" style="max-width:36rem">
  <h2>Opening hours</h2>
  <p class="tpl-muted">Monday – Friday: 00:00 – 00:00<br>Saturday: 00:00 – 00:00<br>Sunday: closed</p>
  <p>Prefer a form? <a href="/contact">Send us a message</a>.</p>
</div></section>`),
  },
  {
    id: 'coming-soon',
    category: 'Utility',
    name: 'Coming soon',
    description: 'A single centred message for a page or a whole site that is not ready yet.',
    icon: 'bi-hourglass-split',
    sections: ['One centred message'],
    front: { title: 'Coming soon', description: 'Something new is on its way.' },
    body: page(`
<section class="tpl-section" style="min-height:60vh;display:grid;align-items:center"><div class="tpl-wrap tpl-center" style="max-width:40rem">
  <p class="tpl-eyebrow">Coming soon</p>
  <h1>Something new is on its way</h1>
  <p class="tpl-lead">Say what is coming and roughly when. Give people one way to hear about it.</p>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Tell me when it’s ready</a></div>
</div></section>`),
  },

  {
    id: 'features',
    category: 'Marketing',
    name: 'Features',
    description: 'A headline and six features in a grid, with a closing call to action.',
    icon: 'bi-stars',
    sections: ['Introduction', 'Six features', 'Call to action'],
    front: { title: 'Features', description: 'Everything included, at a glance.' },
    body: page(`
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <p class="tpl-eyebrow">Features</p>
  <h1>Everything you need, nothing you don’t</h1>
  <p class="tpl-lead">One sentence that explains how the features below fit together.</p>
</div></section>
<section class="tpl-section"><div class="tpl-wrap">
  <div class="tpl-grid">
${three([
  ['1', 'Feature one', 'What it does and the problem it removes.'],
  ['2', 'Feature two', 'What it does and the problem it removes.'],
  ['3', 'Feature three', 'What it does and the problem it removes.'],
  ['4', 'Feature four', 'What it does and the problem it removes.'],
  ['5', 'Feature five', 'What it does and the problem it removes.'],
  ['6', 'Feature six', 'What it does and the problem it removes.'],
])}
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <h2>See it for yourself</h2>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Get started</a><a class="tpl-btn ghost" href="/pricing">See pricing</a></div>
</div></section>`),
  },
  {
    id: 'team',
    category: 'Company',
    name: 'Team',
    description: 'Introduce the people behind the business, six to a page.',
    icon: 'bi-person-badge',
    sections: ['Introduction', 'Six people', 'Join us'],
    front: { title: 'Our team', description: 'The people you will work with.' },
    body: page(`
<section class="tpl-section"><div class="tpl-wrap tpl-center">
  <p class="tpl-eyebrow">Team</p>
  <h1>Meet the people behind it</h1>
  <p class="tpl-lead">A line about how you work together and what you have in common.</p>
  <div class="tpl-grid">
    <div class="tpl-card"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p><p>One line about them.</p></div>
    <div class="tpl-card"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p><p>One line about them.</p></div>
    <div class="tpl-card"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p><p>One line about them.</p></div>
    <div class="tpl-card"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p><p>One line about them.</p></div>
    <div class="tpl-card"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p><p>One line about them.</p></div>
    <div class="tpl-card"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role</p><p>One line about them.</p></div>
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <h2>Want to join us?</h2><p class="tpl-lead">Say what kind of people you look for.</p>
  <div class="tpl-actions"><a class="tpl-btn" href="/careers">See open roles</a></div>
</div></section>`),
  },
  {
    id: 'testimonials',
    category: 'Marketing',
    name: 'Testimonials',
    description: 'What customers say about you, with a headline number and a call to action.',
    icon: 'bi-chat-quote',
    sections: ['Introduction', 'Three quotes', 'Call to action'],
    front: {
      title: 'What our customers say',
      description: 'Kind words from people we have worked with.',
    },
    body: page(`
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <p class="tpl-eyebrow">Testimonials</p>
  <h1>Trusted by people like you</h1>
  <p class="tpl-lead">Introduce the quotes below in a sentence.</p>
</div></section>
<section class="tpl-section"><div class="tpl-wrap">
  <div class="tpl-grid">
    <div class="tpl-card"><p style="font-size:1.05rem">“Replace this with a real quote from a real customer, in their own words.”</p><p class="tpl-muted" style="margin-top:1rem"><b>Name Surname</b><br>Role, Company</p></div>
    <div class="tpl-card"><p style="font-size:1.05rem">“Replace this with a real quote from a real customer, in their own words.”</p><p class="tpl-muted" style="margin-top:1rem"><b>Name Surname</b><br>Role, Company</p></div>
    <div class="tpl-card"><p style="font-size:1.05rem">“Replace this with a real quote from a real customer, in their own words.”</p><p class="tpl-muted" style="margin-top:1rem"><b>Name Surname</b><br>Role, Company</p></div>
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <h2>Join them</h2>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Get in touch</a></div>
</div></section>`),
  },
  {
    id: 'product',
    category: 'Shop',
    name: 'Product page',
    description: 'One product: picture, price, key points, details and a buy button.',
    icon: 'bi-bag',
    sections: ['Picture and price', 'Details', 'Specifications'],
    front: { title: 'Product name', description: 'What it is and who it is for.' },
    body: page(`
<section class="tpl-section"><div class="tpl-wrap">
  <div class="tpl-grid" style="grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));align-items:start;margin-top:0">
    <div><div class="tpl-thumb" style="aspect-ratio:1/1"></div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem"><div class="tpl-thumb" style="margin:0;aspect-ratio:1/1"></div><div class="tpl-thumb" style="margin:0;aspect-ratio:1/1"></div><div class="tpl-thumb" style="margin:0;aspect-ratio:1/1"></div><div class="tpl-thumb" style="margin:0;aspect-ratio:1/1"></div></div></div>
    <div>
      <p class="tpl-eyebrow">Category</p>
      <h1 style="font-size:2rem">Product name</h1>
      <p style="font-size:1.6rem;font-weight:700;margin:0 0 1rem">$00.00</p>
      <p class="tpl-muted">Two or three sentences: what it is, what makes it different, and who it is for.</p>
      <ul class="tpl-list"><li>First key point</li><li>Second key point</li><li>Third key point</li></ul>
      <div class="tpl-actions"><a class="tpl-btn" href="/contact">Buy now</a><a class="tpl-btn ghost" href="/contact">Ask a question</a></div>
    </div>
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap" style="max-width:46rem">
  <h2>Details</h2>
  <p>A longer description. Cover what is in the box, how it is used, and what people usually want to know before they buy.</p>
  <h3 style="margin-top:1.5rem">Specifications</h3>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:0.5rem 0;border-bottom:1px solid var(--line,#dde3e1)" class="tpl-muted">Size</td><td style="padding:0.5rem 0;border-bottom:1px solid var(--line,#dde3e1)">00 × 00</td></tr>
    <tr><td style="padding:0.5rem 0;border-bottom:1px solid var(--line,#dde3e1)" class="tpl-muted">Weight</td><td style="padding:0.5rem 0;border-bottom:1px solid var(--line,#dde3e1)">00</td></tr>
    <tr><td style="padding:0.5rem 0;border-bottom:1px solid var(--line,#dde3e1)" class="tpl-muted">Material</td><td style="padding:0.5rem 0;border-bottom:1px solid var(--line,#dde3e1)">Material</td></tr>
  </table>
</div></section>`),
  },
  {
    id: 'article',
    category: 'Content',
    name: 'Article',
    description: 'A long read: headline, byline, readable text with sub-headings and a pull quote.',
    icon: 'bi-journal-text',
    sections: ['Headline and byline', 'Body with sub-headings', 'Pull quote', 'Keep reading'],
    front: { title: 'Article headline', description: 'A one-sentence summary of the article.' },
    body: page(`
<article class="tpl-section"><div class="tpl-wrap" style="max-width:44rem">
  <p class="tpl-eyebrow">Category</p>
  <h1>A headline that says what the article is about</h1>
  <p class="tpl-muted">By Author Name · Month 00, 0000 · 0 min read</p>
  <div class="tpl-thumb" style="aspect-ratio:16/9;margin:1.5rem 0"></div>
  <p class="tpl-lead">An opening paragraph that makes the reader want the second one.</p>
  <p>Body text. Keep paragraphs short and let each one make a single point.</p>
  <h2 style="margin-top:2rem">A sub-heading</h2>
  <p>More body text. Use sub-headings so people can scan before they read.</p>
  <blockquote style="margin:1.75rem 0;padding:0.25rem 0 0.25rem 1.25rem;border-left:4px solid var(--accent,#2b59c3);font-size:1.25rem">A sentence worth pulling out of the text.</blockquote>
  <h2>Another sub-heading</h2>
  <p>Closing text. End with what the reader can do next.</p>
</div></article>
<section class="tpl-section tpl-soft"><div class="tpl-wrap" style="max-width:44rem">
  <h2>Keep reading</h2>
  <p><a href="/blog">More articles →</a></p>
</div></section>`),
  },
  {
    id: 'gallery',
    category: 'Showcase',
    name: 'Gallery',
    description: 'A tidy grid of pictures with short captions.',
    icon: 'bi-images',
    sections: ['Introduction', 'Twelve pictures'],
    front: { title: 'Gallery', description: 'A look at our work and our world.' },
    body: page(`
<section class="tpl-section"><div class="tpl-wrap">
  <p class="tpl-eyebrow">Gallery</p>
  <h1>A picture is worth a few words</h1>
  <p class="tpl-lead">Say what the pictures show and when they were taken.</p>
  <div class="tpl-grid" style="grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))">
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
    <figure style="margin:0"><div class="tpl-thumb"></div><figcaption class="tpl-muted">Caption</figcaption></figure>
  </div>
  <p class="tpl-muted" style="margin-top:1.5rem">Replace each grey block with a picture from the media library.</p>
</div></section>`),
  },
  {
    id: 'careers',
    category: 'Company',
    name: 'Careers',
    description: 'Why work with you, the benefits, and a list of open roles.',
    icon: 'bi-person-workspace',
    sections: ['Introduction', 'Benefits', 'Open roles'],
    front: { title: 'Careers', description: 'Come and work with us.' },
    body: page(`
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <p class="tpl-eyebrow">Careers</p>
  <h1>Work on something you’re proud of</h1>
  <p class="tpl-lead">Say what the work is like and what kind of people do well here.</p>
</div></section>
<section class="tpl-section"><div class="tpl-wrap">
  <div class="tpl-center"><h2>What you get</h2></div>
  <div class="tpl-grid">
${three([
  ['✦', 'Benefit one', 'A line about what it means for you.'],
  ['✦', 'Benefit two', 'A line about what it means for you.'],
  ['✦', 'Benefit three', 'A line about what it means for you.'],
])}
  </div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap" style="max-width:46rem">
  <h2>Open roles</h2>
  <div class="tpl-card" style="margin-bottom:0.75rem"><h3>Role title</h3><p class="tpl-muted">Team · Location · Full time</p><a href="/contact">Apply →</a></div>
  <div class="tpl-card" style="margin-bottom:0.75rem"><h3>Role title</h3><p class="tpl-muted">Team · Location · Full time</p><a href="/contact">Apply →</a></div>
  <div class="tpl-card"><h3>Role title</h3><p class="tpl-muted">Team · Location · Part time</p><a href="/contact">Apply →</a></div>
  <p class="tpl-muted" style="margin-top:1rem">Nothing open right now? Say so, and say how people can still get in touch.</p>
</div></section>`),
  },
  {
    id: 'event',
    category: 'Marketing',
    name: 'Event',
    description: 'Date and place, a schedule, who is speaking, and a way to register.',
    icon: 'bi-calendar-event',
    sections: ['Date and place', 'Schedule', 'Speakers', 'Register'],
    front: { title: 'Event name', description: 'When, where and what to expect.' },
    body: page(`
<section class="tpl-section tpl-soft"><div class="tpl-wrap tpl-center">
  <p class="tpl-eyebrow">Month 00, 0000 · City</p>
  <h1>Event name</h1>
  <p class="tpl-lead">One line on what the event is and who should come.</p>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Register</a></div>
</div></section>
<section class="tpl-section"><div class="tpl-wrap" style="max-width:46rem">
  <h2>Schedule</h2>
  <div class="tpl-card" style="margin-bottom:0.75rem"><b>00:00</b> — Doors open</div>
  <div class="tpl-card" style="margin-bottom:0.75rem"><b>00:00</b> — First session</div>
  <div class="tpl-card" style="margin-bottom:0.75rem"><b>00:00</b> — Break</div>
  <div class="tpl-card"><b>00:00</b> — Second session</div>
</div></section>
<section class="tpl-section tpl-soft"><div class="tpl-wrap">
  <div class="tpl-center"><h2>Speakers</h2></div>
  <div class="tpl-grid">
    <div class="tpl-card tpl-center"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role, Company</p></div>
    <div class="tpl-card tpl-center"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role, Company</p></div>
    <div class="tpl-card tpl-center"><div class="tpl-avatar"></div><h3>Name Surname</h3><p class="tpl-muted">Role, Company</p></div>
  </div>
</div></section>
<section class="tpl-section"><div class="tpl-wrap tpl-center">
  <h2>Where to find us</h2><p class="tpl-lead">Venue name, street, city. How to get there.</p>
  <div class="tpl-actions"><a class="tpl-btn" href="/contact">Register now</a></div>
</div></section>`),
  },
  {
    id: 'price-list',
    category: 'Shop',
    name: 'Price list / menu',
    description: 'Items and prices in clear sections — a menu, a rate card or a service list.',
    icon: 'bi-list-ul',
    sections: ['Introduction', 'Three sections of items and prices'],
    front: { title: 'Price list', description: 'What we offer and what it costs.' },
    body: page(`
<section class="tpl-section"><div class="tpl-wrap" style="max-width:46rem">
  <p class="tpl-eyebrow">Price list</p>
  <h1>What we offer</h1>
  <p class="tpl-lead">Say what the prices include and when they were last updated.</p>
  <h2 style="margin-top:2rem">Section one</h2>
  <div class="tpl-card" style="padding:0.4rem 1.2rem">
    <div style="display:flex;justify-content:space-between;gap:1rem;padding:0.7rem 0;border-bottom:1px solid var(--line,#dde3e1)"><span><b>Item name</b><br><span class="tpl-muted">A short description</span></span><b>$00</b></div>
    <div style="display:flex;justify-content:space-between;gap:1rem;padding:0.7rem 0;border-bottom:1px solid var(--line,#dde3e1)"><span><b>Item name</b><br><span class="tpl-muted">A short description</span></span><b>$00</b></div>
    <div style="display:flex;justify-content:space-between;gap:1rem;padding:0.7rem 0"><span><b>Item name</b><br><span class="tpl-muted">A short description</span></span><b>$00</b></div>
  </div>
  <h2 style="margin-top:2rem">Section two</h2>
  <div class="tpl-card" style="padding:0.4rem 1.2rem">
    <div style="display:flex;justify-content:space-between;gap:1rem;padding:0.7rem 0;border-bottom:1px solid var(--line,#dde3e1)"><span><b>Item name</b><br><span class="tpl-muted">A short description</span></span><b>$00</b></div>
    <div style="display:flex;justify-content:space-between;gap:1rem;padding:0.7rem 0"><span><b>Item name</b><br><span class="tpl-muted">A short description</span></span><b>$00</b></div>
  </div>
  <h2 style="margin-top:2rem">Section three</h2>
  <div class="tpl-card" style="padding:0.4rem 1.2rem">
    <div style="display:flex;justify-content:space-between;gap:1rem;padding:0.7rem 0;border-bottom:1px solid var(--line,#dde3e1)"><span><b>Item name</b><br><span class="tpl-muted">A short description</span></span><b>$00</b></div>
    <div style="display:flex;justify-content:space-between;gap:1rem;padding:0.7rem 0"><span><b>Item name</b><br><span class="tpl-muted">A short description</span></span><b>$00</b></div>
  </div>
</div></section>`),
  },
  {
    id: 'privacy',
    category: 'Legal',
    name: 'Privacy policy',
    description:
      'A starting outline for a privacy policy. Not legal advice — have it checked before you publish.',
    icon: 'bi-shield-lock',
    sections: ['What we collect', 'How we use it', 'Sharing', 'Your rights', 'Contact'],
    front: { title: 'Privacy policy', description: 'How we handle your personal information.' },
    body: page(`
<!-- Replace every [bracketed] part. This is an outline, not legal advice: have it reviewed for the places you operate in. -->
<article class="tpl-section"><div class="tpl-wrap" style="max-width:44rem">
  <h1>Privacy policy</h1>
  <p class="tpl-muted">Last updated: [date]</p>
  <p>[Company name] (“we”) respects your privacy. This page explains what personal information we collect, why, and what choices you have.</p>
  <h2 style="margin-top:2rem">What we collect</h2>
  <p>[List the information you collect: for example contact details, messages you send us, and how the site is used.]</p>
  <h2 style="margin-top:2rem">How we use it</h2>
  <p>[Explain each purpose: replying to you, running the site, improving it, legal requirements.]</p>
  <h2 style="margin-top:2rem">Who we share it with</h2>
  <p>[Name the kinds of service providers you use, and say whether you ever sell or share data for advertising.]</p>
  <h2 style="margin-top:2rem">How long we keep it</h2>
  <p>[State retention periods.]</p>
  <h2 style="margin-top:2rem">Your rights</h2>
  <p>[Describe how people can see, correct or delete their information, and how to complain.]</p>
  <h2 style="margin-top:2rem">Cookies</h2>
  <p>[Say which cookies the site sets and why.]</p>
  <h2 style="margin-top:2rem">Contact us</h2>
  <p>[Name, address and email for privacy questions.]</p>
</div></article>`),
  },
  {
    id: 'terms',
    category: 'Legal',
    name: 'Terms of service',
    description:
      'A starting outline for terms and conditions. Not legal advice — have it checked before you publish.',
    icon: 'bi-file-earmark-text',
    sections: ['Using the site', 'Orders and payment', 'Liability', 'Changes', 'Contact'],
    front: {
      title: 'Terms of service',
      description: 'The terms for using this site and our services.',
    },
    body: page(`
<!-- Replace every [bracketed] part. This is an outline, not legal advice: have it reviewed for the places you operate in. -->
<article class="tpl-section"><div class="tpl-wrap" style="max-width:44rem">
  <h1>Terms of service</h1>
  <p class="tpl-muted">Last updated: [date]</p>
  <p>By using this site or our services you agree to these terms. [Company name] (“we”) is based in [place].</p>
  <h2 style="margin-top:2rem">Using the site</h2>
  <p>[Say what people may and may not do, and who may use the site.]</p>
  <h2 style="margin-top:2rem">Orders and payment</h2>
  <p>[Describe prices, payment, delivery, cancellations and refunds — or delete this section if you do not sell anything.]</p>
  <h2 style="margin-top:2rem">Our content</h2>
  <p>[State who owns the content on the site and how it may be used.]</p>
  <h2 style="margin-top:2rem">Liability</h2>
  <p>[Explain what you are and are not responsible for.]</p>
  <h2 style="margin-top:2rem">Changes</h2>
  <p>[Say how you will tell people when these terms change.]</p>
  <h2 style="margin-top:2rem">Governing law and contact</h2>
  <p>[Which law applies, and how to reach you.]</p>
</div></article>`),
  },
  {
    id: 'thank-you',
    category: 'Utility',
    name: 'Thank you',
    description:
      'Shown after someone sends a message or places an order: confirmation and what happens next.',
    icon: 'bi-check-circle',
    sections: ['Confirmation', 'What happens next'],
    front: { title: 'Thank you', description: 'We have received your message.' },
    body: page(`
<section class="tpl-section" style="min-height:55vh;display:grid;align-items:center"><div class="tpl-wrap tpl-center" style="max-width:38rem">
  <div class="tpl-icon" style="margin:0 auto 1rem;width:3.5rem;height:3.5rem;font-size:1.6rem">✓</div>
  <h1>Thank you</h1>
  <p class="tpl-lead">Say what you have received and how soon people will hear back.</p>
  <div class="tpl-actions"><a class="tpl-btn" href="/">Back to the home page</a></div>
</div></section>`),
  },
];

/** What the gallery shows: everything except the page source itself. */
export const templateCards = () =>
  TEMPLATES.map(({ id, category, name, description, icon, sections }) => ({
    id,
    category,
    name,
    description,
    icon,
    sections,
  }));

export const templateById = (/** @type {string} */ id) =>
  TEMPLATES.find((t) => t.id === id) ?? null;
