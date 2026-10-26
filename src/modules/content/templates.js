import { now } from '../../core/db/index.js';
import { HttpError, forbidden, notFound } from '../../core/http/errors.js';

const p = (text) => ({ type: 'paragraph', data: { text } });
const h = (text, level = 2) => ({ type: 'header', data: { text, level } });
const li = (...items) => ({ type: 'list', data: { style: 'unordered', items } });
const ol = (...items) => ({ type: 'list', data: { style: 'ordered', items } });
const note = (style, title, text) => ({ type: 'callout', data: { style, title, text } });
const doc = (...blocks) => ({ blocks });

/**
 * Starting points that ship with the platform, per content type. They are code, not rows, so every site has them,
 * they can't be deleted by accident, and an update can improve them.
 */
const BUILT_IN = {
  post: [
    {
      id: 'builtin:blog-post',
      name: 'Blog post',
      description: 'An opening, three sections and a conclusion.',
      data: {
        excerpt: 'One sentence that says what the reader will learn.',
        body: doc(
          p('Open with the problem or question your reader has, in two or three sentences.'),
          h('The first point'),
          p('Explain it with an example.'),
          h('The second point'),
          p('Back it up with a number, a quote or a picture.'),
          h('The third point'),
          p('Say what to do about it.'),
          h('Summing up'),
          p('Repeat the main takeaway and tell the reader what to do next.'),
          { type: 'button', data: { text: 'Get in touch', url: '/contact', look: 'primary' } },
        ),
      },
    },
    {
      id: 'builtin:case-study',
      name: 'Case study',
      description: 'Customer, challenge, solution and results.',
      data: {
        excerpt: 'How {customer} solved {problem} with us, and what changed.',
        body: doc(
          note('info', 'At a glance', 'Customer, industry, size, what we did, how long it took.'),
          h('The challenge'),
          p('What was not working, and what it was costing the customer.'),
          h('The solution'),
          p('What we did, in the order we did it.'),
          ol('First step', 'Second step', 'Third step'),
          h('The results'),
          {
            type: 'table',
            data: {
              header: true,
              rows: [
                ['Measure', 'Before', 'After'],
                ['', '', ''],
                ['', '', ''],
              ],
            },
          },
          {
            type: 'quote',
            data: { text: 'A sentence from the customer.', caption: 'Name, role, company' },
          },
          {
            type: 'button',
            data: { text: 'Talk to us about your project', url: '/contact', look: 'primary' },
          },
        ),
      },
    },
    {
      id: 'builtin:how-to',
      name: 'How-to guide',
      description: 'What you need, numbered steps, and common problems.',
      data: {
        excerpt: 'Step by step: how to {do the thing}.',
        body: doc(
          p('Say what the reader will be able to do at the end, and how long it takes.'),
          h('What you need'),
          li('The first thing', 'The second thing'),
          h('Steps'),
          ol('Do this.', 'Then this.', 'Finally this.'),
          note('warning', 'Watch out', 'The mistake most people make.'),
          h('If something goes wrong'),
          p('The two or three problems people hit, and how to fix them.'),
        ),
      },
    },
    {
      id: 'builtin:announcement',
      name: 'News or announcement',
      description: 'What happened, why it matters, what happens next.',
      data: {
        excerpt: 'Today we are announcing {news}.',
        body: doc(
          p('Lead with the news: who, what and when, in one or two sentences.'),
          h('Why it matters'),
          p('What changes for the reader.'),
          h('What happens next'),
          p('Dates, links and who to ask.'),
        ),
      },
    },
  ],
  page: [
    {
      id: 'builtin:landing',
      name: 'Landing page',
      description: 'A promise, three benefits and a call to action.',
      data: {
        excerpt: 'One sentence about what this page offers.',
        body: doc(
          h('A promise in one line', 2),
          p('Say who this is for and what they get.'),
          {
            type: 'button',
            data: { text: 'Get started', url: '/contact', look: 'primary', align: 'left' },
          },
          h('Why choose us', 2),
          li('First benefit', 'Second benefit', 'Third benefit'),
          { type: 'quote', data: { text: 'A short testimonial.', caption: 'Name, company' } },
          h('Ready when you are', 2),
          { type: 'button', data: { text: 'Contact us', url: '/contact', look: 'outline' } },
        ),
      },
    },
    {
      id: 'builtin:faq',
      name: 'Frequently asked questions',
      description: 'A question as a heading, an answer under it.',
      data: {
        excerpt: 'Answers to the questions we hear most.',
        body: doc(
          h('First question?', 2),
          p('The answer, in a sentence or two.'),
          h('Second question?', 2),
          p('The answer.'),
          h('Third question?', 2),
          p('The answer.'),
        ),
      },
    },
  ],
};

/**
 * Content templates: built-ins plus ones people save from their own entries.
 * @param {{db: any, dialect: any, registry: any, audit: any}} deps
 */
export function createContentTemplates({ db, dialect, registry, audit }) {
  const row = (r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    builtIn: false,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: Number(r.created_at),
    data: JSON.parse(r.data || '{}'),
  });

  /** Only the writing travels: blocks and the summary. Search title, image and address belong to the entry. */
  function keep(typeId, data) {
    const type = registry.type(typeId);
    const clean = registry.cleanData(typeId, data);
    const out = {};
    for (const f of Object.values(type.fields))
      if (f.type === 'blocks' || f.key === 'excerpt') out[f.key] = clean[f.key];
    return out;
  }

  return {
    builtIn: (typeId) => (BUILT_IN[typeId] ?? []).map((t) => ({ ...t, builtIn: true })),

    async list(typeId) {
      registry.type(typeId);
      const rows = await db('content_templates').where({ type: typeId }).orderBy('name');
      return [...this.builtIn(typeId), ...rows.map(row)];
    },

    async create(typeId, input, actor = null) {
      const name = String(input.name ?? '').trim();
      if (!name || name.length > 120)
        throw new HttpError(
          422,
          'invalid_input',
          'Give the template a name of up to 120 characters.',
          {
            field: 'name',
          },
        );
      const data = keep(typeId, input.data ?? {});
      // A template is a way around the HTML-block permission if anyone with write access can store one.
      const hasHtml = Object.values(data).some((v) => v?.blocks?.some((b) => b.type === 'html'));
      if (hasHtml && actor && !actor.can('content.html_blocks'))
        throw forbidden(
          'A template with a custom HTML block needs the “Use custom HTML blocks” permission.',
        );
      if (await db('content_templates').where({ type: typeId, name }).first())
        throw new HttpError(
          409,
          'name_taken',
          'A template with that name exists. Choose another name.',
          {
            field: 'name',
          },
        );
      const id = await dialect.insertGetId(db('content_templates'), {
        type: typeId,
        name,
        description: String(input.description ?? '').slice(0, 255) || null,
        data: JSON.stringify(data),
        created_by: actor?.id ?? null,
        created_at: now(),
      });
      await audit.log({
        actor,
        action: 'content.template_create',
        entity: typeId,
        entityId: id,
        meta: { name },
      });
      return row(await db('content_templates').where({ id }).first());
    },

    async remove(id, actor = null) {
      const r = await db('content_templates')
        .where({ id: Number(id) || 0 })
        .first();
      if (!r) throw notFound('Template');
      if (actor && r.created_by !== actor.id && !actor.can('content.templates.manage'))
        throw forbidden(
          'You can delete templates you saved. Others need the “Manage templates” permission.',
        );
      await db('content_templates').where({ id: r.id }).delete();
      await audit.log({
        actor,
        action: 'content.template_delete',
        entity: r.type,
        entityId: r.id,
        meta: { name: r.name },
      });
    },
  };
}
