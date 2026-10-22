import { now } from '../../core/db/index.js';
import { HttpError } from '../../core/http/errors.js';

/** A confirmed deletion must be carried out within this long, or the person has to confirm again. */
const VALID_MS = 10 * 60_000;

/**
 * The double-confirmation gate for deletions the assistant asks for (docs/DECISIONS.md D-119). Same idea as the plan
 * gate (D-083): the model stages a deletion with a tool, only a person can answer it through the chat's own buttons,
 * and the model cannot set or skip the answer. Two separate requests are needed (`first`, then `second`); dropping a
 * whole table also needs its name typed at the second. The delete tool consumes a confirmation exactly once.
 * @param {{ db: any, dialect: any, audit: any }} deps
 */
export function createConfirmations({ db, dialect, audit }) {
  const view = (r) => ({
    id: Number(r.id),
    kind: r.kind,
    target: JSON.parse(r.target),
    summary: r.summary,
    status: r.status,
    createdAt: Number(r.created_at),
  });

  return {
    async propose(sessionId, { kind, target, summary }) {
      // A newer request replaces older ones nobody answered.
      await db('assistant_confirmations')
        .where({ session_id: sessionId })
        .whereIn('status', ['pending', 'first'])
        .update({ status: 'cancelled' });
      const id = await dialect.insertGetId(db('assistant_confirmations'), {
        session_id: sessionId,
        kind,
        target: JSON.stringify(target),
        summary: String(summary).slice(0, 400),
        status: 'pending',
        created_at: now(),
      });
      return id;
    },

    async list(sessionId) {
      const rows = await db('assistant_confirmations')
        .where({ session_id: sessionId })
        .orderBy('id');
      return rows.map(view);
    },

    /**
     * The person's click. `first` asks "are you sure?", `second` confirms for real, `cancel` backs out.
     * @param {'first'|'second'|'cancel'} step
     */
    async decide(sessionId, id, step, typed, actor) {
      if (!actor?.can('dbms.write'))
        throw new HttpError(
          403,
          'forbidden',
          'You need the "dbms.write" permission to confirm this.',
        );
      const r = await db('assistant_confirmations').where({ id, session_id: sessionId }).first();
      if (!r)
        throw new HttpError(404, 'not_found', 'That deletion request was not found in this chat.');
      const target = JSON.parse(r.target);
      const stale = () =>
        new HttpError(
          409,
          'conflict',
          'This request was already answered or replaced. Ask the assistant again.',
        );
      let from, to;
      if (step === 'first') [from, to] = ['pending', 'first'];
      else if (step === 'second') {
        [from, to] = ['first', 'confirmed'];
        if (r.kind === 'table' && String(typed ?? '').trim() !== target.table)
          throw new HttpError(
            422,
            'invalid_input',
            `Type the table name "${target.table}" exactly to confirm.`,
            { field: 'typed' },
          );
      } else if (step === 'cancel') {
        if (!['pending', 'first'].includes(r.status)) throw stale();
        await db('assistant_confirmations')
          .where({ id })
          .update({ status: 'cancelled', decided_at: now() });
        return { status: 'cancelled' };
      } else throw new HttpError(422, 'invalid_input', 'Choose first, second or cancel.');
      // Conditional update: a double-click or a second tab cannot skip a step or answer twice.
      const n = await db('assistant_confirmations')
        .where({ id, status: from })
        .update({ status: to, decided_by: actor.id ?? null, decided_at: now() });
      if (!n) throw stale();
      await audit.log({
        actor,
        action: `assistant.delete_${to}`,
        entity: 'assistant_confirmation',
        entityId: id,
        meta: { kind: r.kind, table: target.table },
      });
      return { status: to };
    },

    /** Used by the delete tool: returns the confirmed target and spends the confirmation, or throws what to tell the model. */
    async consume(sessionId, id) {
      const r = await db('assistant_confirmations').where({ id, session_id: sessionId }).first();
      if (!r)
        throw new Error(
          'There is no such deletion request in this chat. Call db_request_delete first.',
        );
      if (r.status === 'used') throw new Error('That deletion was already carried out.');
      if (r.status !== 'confirmed')
        throw new Error(
          r.status === 'cancelled'
            ? 'The person cancelled this deletion. Do not try again unless they ask.'
            : 'The person has not confirmed this deletion yet (it needs two confirmations). Stop and wait; nothing was deleted.',
        );
      if (now() - Number(r.decided_at) > VALID_MS)
        throw new Error(
          'The confirmation expired. Call db_request_delete again if they still want it.',
        );
      const n = await db('assistant_confirmations')
        .where({ id, status: 'confirmed' })
        .update({ status: 'used' });
      if (!n) throw new Error('That deletion was already carried out.');
      return { kind: r.kind, target: JSON.parse(r.target) };
    },
  };
}
