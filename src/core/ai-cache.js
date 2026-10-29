/**
 * Prompt-caching helpers shared by every AI feature (D-132). A request is cached as a prefix, in the order tools →
 * system → messages, so a marker on the last block of each part makes the next call in the same task read it back at a
 * fraction of the price. Anthropic ignores a marker on a prefix below the model's minimum size, so these are safe to
 * add everywhere. Each helper copies; none edits what the caller stored.
 */

const MARK = { type: 'ephemeral' };

/** A system prompt as one cacheable block. @param {string} text */
export function cachedSystem(text) {
  return [{ type: 'text', text, cache_control: MARK }];
}

/**
 * Marks the end of the conversation so far as cacheable: the next request (after a tool result) then reads everything
 * before it from the cache instead of paying for it again.
 * @param {{role: string, content: any}[]} msgs
 */
export function withHistoryCache(msgs) {
  if (!msgs.length) return msgs;
  const last = msgs[msgs.length - 1];
  const blocks =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : last.content.map((b) => ({ ...b }));
  if (!blocks.length) return msgs;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: MARK };
  return [...msgs.slice(0, -1), { ...last, content: blocks }];
}

/** The tool list with its last definition marked, so the whole list is one cached prefix. @param {any[]} tools */
export function cachedTools(tools) {
  if (!tools.length) return tools;
  return [...tools.slice(0, -1), { ...tools[tools.length - 1], cache_control: MARK }];
}
