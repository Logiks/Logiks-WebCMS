/**
 * Token-aware sizing of the Assistant's context (D-133). The history sent to the model is kept inside a token budget
 * instead of a fixed number of turns: many short turns all stay, a few huge ones are cut sooner. Nothing here calls
 * the API; sizes are estimates from characters, corrected by the real `usage` the API returned for the previous call.
 */

/** Characters per token for English text and JSON; deliberately a little pessimistic. */
const CHARS_PER_TOKEN = 3.5;
/** A picture costs roughly this many tokens whatever its size (after the API's own downscaling). */
const IMAGE_CHARS = 1500 * CHARS_PER_TOKEN;
/** What may be spent on earlier turns; the rest of the budget is left for the current turn's reading and writing. */
const HISTORY_SHARE = 0.5;
/** After older turns are folded into the summary, history is cut down to this share of its allowance, so the cut does not move on every turn (a moving cut breaks the prompt cache each time). */
const RELAX = 0.6;
/** Tool results of the current turn that always stay whole, however tight the budget (the model needs the latest). */
const KEEP_RESULTS = [6, 3, 2, 1];

/** @param {number} chars */
export const tokensOf = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

/** Size in characters of one content block, as it would be sent. */
function blockChars(b) {
  if (b.type === 'text') return b.text?.length ?? 0;
  if (b.type === 'image' || b.type === 'image_ref') return b.type === 'image' ? IMAGE_CHARS : 60;
  if (b.type === 'tool_use')
    return JSON.stringify(b.input ?? {}).length + (b.name?.length ?? 0) + 40;
  if (b.type === 'tool_result') {
    if (typeof b.content === 'string') return b.content.length + 40;
    return (b.content ?? []).reduce((n, x) => n + blockChars(x), 40);
  }
  return JSON.stringify(b).length;
}

/** Estimated size in characters of a message list. @param {{content: any}[]} msgs */
export const charsOf = (msgs) =>
  msgs.reduce(
    (n, m) =>
      n +
      (typeof m.content === 'string'
        ? m.content.length
        : m.content.reduce((a, b) => a + blockChars(b), 0)) +
      8,
    0,
  );

/**
 * A tool result with its body replaced by a short stub (pictures dropped), keeping the id so the pair stays valid.
 * @param {any} b a tool_result block
 * @param {number} keep characters of text to keep
 */
export function stubResult(b, keep) {
  const text =
    typeof b.content === 'string'
      ? b.content
      : (b.content ?? [])
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('\n');
  return {
    ...b,
    content: `${text.slice(0, keep)}…[result dropped to save space; read it again if you still need it]`,
  };
}

/** The part of the budget that earlier turns may use. @param {number} budget */
export const historyAllowance = (budget) => Math.floor(budget * HISTORY_SHARE);

/** Relax target once a cut is needed. @param {number} budget */
export const relaxedAllowance = (budget) => Math.floor(historyAllowance(budget) * RELAX);

/**
 * Shrinks the current turn when the whole request would exceed the budget: tool results older than the latest few are
 * reduced to a stub, trying to keep 6, then 3, 2 and finally only the latest. Work on a copy; returns how many were
 * stubbed. Text the assistant and the person wrote is never touched.
 * @param {{role: string, content: any}[]} out the messages about to be sent (edited in place; they are copies)
 * @param {number} firstCurrent index in `out` where the current turn begins
 * @param {() => boolean} fits whether the request is small enough now
 * @param {number} keepChars text kept from a stubbed result
 */
export function shrinkCurrentTurn(out, firstCurrent, fits, keepChars) {
  const rounds = [];
  for (let i = firstCurrent; i < out.length; i++)
    if (Array.isArray(out[i].content) && out[i].content.some((b) => b.type === 'tool_result'))
      rounds.push(i);
  let stubbed = 0;
  for (const keep of KEEP_RESULTS) {
    if (fits()) break;
    for (const i of rounds.slice(0, Math.max(0, rounds.length - keep))) {
      const blocks = out[i].content.map((b) => {
        if (b.type !== 'tool_result' || String(b.content).includes('[result dropped')) return b;
        stubbed++;
        return stubResult(b, keepChars);
      });
      out[i] = { ...out[i], content: blocks };
    }
  }
  return stubbed;
}
