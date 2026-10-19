import { z } from 'zod';
import { now } from '../../core/db/index.js';
import { HttpError } from '../../core/http/errors.js';

/** An approval covers the building that follows it for this long; after that a new big build needs a new plan. */
const APPROVAL_MS = 6 * 3_600_000;

const list = (max, item = z.string().trim().min(1).max(300)) => z.array(item).max(max).default([]);
export const planSchema = z.object({
  title: z.string().trim().min(3, 'Give the plan a title.').max(120),
  summary: z.string().trim().max(800).default(''),
  assumptions: list(15).refine((a) => a.length > 0, 'List the assumptions you are making.'),
  pages: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(160),
        purpose: z.string().trim().max(300).default(''),
      }),
    )
    .max(40)
    .default([]),
  components: list(30),
  content: list(20),
  design: z.string().trim().max(800).default(''),
  sample_content: list(15),
  steps: list(12),
});

const bullets = (a) => a.map((x) => `- ${x}`).join('\n');

/** The plan as the requirements document keeps it. */
export function planMarkdown(p) {
  return [
    p.summary,
    '**Assumptions**',
    bullets(p.assumptions),
    p.pages.length && '**Pages**',
    p.pages.length &&
      bullets(p.pages.map((x) => `\`${x.path}\`${x.purpose ? ` — ${x.purpose}` : ''}`)),
    p.components.length && '**Components**',
    p.components.length && bullets(p.components),
    p.content.length && '**Content and data**',
    p.content.length && bullets(p.content),
    p.design && `**Design direction**\n${p.design}`,
    p.sample_content.length && '**Sample content (to be replaced by the owner)**',
    p.sample_content.length && bullets(p.sample_content),
    p.steps.length && '**Build order**',
    p.steps.length && p.steps.map((x, i) => `${i + 1}. ${x}`).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The plan-approval gate (docs/DECISIONS.md D-083). The assistant proposes a plan with a tool; only a person, through
 * the chat's own buttons, can approve it. The model can neither approve nor edit the stored decision, so a build-sized
 * change cannot slip past the person's yes by the model skipping the instruction.
 * @param {{ db: any, dialect: any, requirements: any, audit: any }} deps
 */
export function createPlans({ db, dialect, requirements, audit }) {
  const view = (r) => ({
    id: Number(r.id),
    status: r.status,
    note: r.note || '',
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    createdAt: Number(r.created_at),
    plan: JSON.parse(r.payload),
  });

  return {
    /** A new proposal replaces any earlier one that was still open or approved. */
    async propose(sessionId, input) {
      const plan = planSchema.parse(input);
      const t = now();
      await db('assistant_plans')
        .where({ session_id: sessionId })
        .whereIn('status', ['pending', 'approved'])
        .update({ status: 'superseded' });
      const id = await dialect.insertGetId(db('assistant_plans'), {
        session_id: sessionId,
        payload: JSON.stringify(plan),
        status: 'pending',
        created_at: t,
      });
      return { id, plan };
    },

    async list(sessionId) {
      const rows = await db('assistant_plans').where({ session_id: sessionId }).orderBy('id');
      return rows.map(view);
    },

    /** What the write gate needs to know about this chat. */
    async status(sessionId) {
      const r = await db('assistant_plans')
        .where({ session_id: sessionId })
        .orderBy('id', 'desc')
        .first();
      if (!r) return { approved: false, pending: false };
      return {
        approved: r.status === 'approved' && now() - Number(r.decided_at) < APPROVAL_MS,
        pending: r.status === 'pending',
      };
    },

    /**
     * The person's decision. Approving also records the plan under “Brief and assumptions” when they may edit the
     * requirements; otherwise the assistant is asked to do it.
     * @param {'approve'|'changes'|'reject'} decision
     */
    async decide(sessionId, planId, decision, note, actor) {
      const r = await db('assistant_plans').where({ id: planId, session_id: sessionId }).first();
      if (!r) throw new HttpError(404, 'not_found', 'That plan was not found in this chat.');
      if (r.status !== 'pending')
        throw new HttpError(
          409,
          'conflict',
          r.status === 'superseded'
            ? 'A newer plan replaced this one. Decide on the newer plan.'
            : 'This plan has already been decided.',
        );
      const status = { approve: 'approved', changes: 'changes', reject: 'rejected' }[decision];
      if (!status) throw new HttpError(422, 'invalid_input', 'Choose approve, changes or reject.');
      if (decision === 'changes' && !String(note ?? '').trim())
        throw new HttpError(422, 'invalid_input', 'Say what should change in the plan.');
      await db('assistant_plans')
        .where({ id: planId })
        .update({
          status,
          note: String(note ?? '').slice(0, 2000) || null,
          decided_by: actor?.id ?? null,
          decided_at: now(),
        });
      let saved = false;
      if (decision === 'approve' && actor?.can('requirements.write')) {
        await requirements.setSection(
          'Brief and assumptions',
          planMarkdown(JSON.parse(r.payload)),
          actor,
        );
        saved = true;
      }
      await audit.log({
        actor,
        action: `assistant.plan_${status}`,
        entity: 'assistant_plan',
        entityId: planId,
      });
      return { status, savedToRequirements: saved };
    },
  };
}
