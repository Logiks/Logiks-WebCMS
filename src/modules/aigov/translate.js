/**
 * Anthropic ⇄ OpenAI chat formats. The CMS speaks Anthropic's shape everywhere (messages with content blocks, tool_use /
 * tool_result); a local model speaks OpenAI's. These two functions are the only place the difference is handled.
 */

const textOf = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
      : '';

/** @param {any} params an Anthropic `messages` request @param {string} model */
export function toOpenAI(params, model) {
  const out = [];
  const sys = textOf(params.system);
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of params.messages ?? []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg = { role: 'assistant', content: textOf(blocks) || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    // A user turn: tool results become their own `tool` messages and must come first.
    for (const b of blocks.filter((x) => x.type === 'tool_result'))
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: textOf(b.content) });
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.source?.type === 'base64')
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
        });
    }
    if (parts.length)
      out.push({
        role: 'user',
        content: parts.every((p) => p.type === 'text')
          ? parts.map((p) => p.text).join('\n')
          : parts,
      });
  }
  /** @type {any} */
  const body = { model, messages: out, stream: false };
  if (params.max_tokens) body.max_tokens = params.max_tokens;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  if (params.stop_sequences?.length) body.stop = params.stop_sequences;
  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema },
    }));
    const tc = params.tool_choice;
    if (tc?.type === 'any') body.tool_choice = 'required';
    else if (tc?.type === 'none') body.tool_choice = 'none';
    else if (tc?.type === 'tool')
      body.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return body;
}

const STOP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
};

/**
 * An OpenAI chat completion as the Anthropic message the callers already understand.
 * Throws when the model's tool arguments are not JSON: the gateway then treats the profile as unusable and falls back,
 * rather than running a tool with empty input.
 * @param {any} json @param {string} model
 */
export function fromOpenAI(json, model) {
  const choice = json?.choices?.[0];
  if (!choice?.message) throw new Error('The model sent no answer.');
  const content = [];
  const text = typeof choice.message.content === 'string' ? choice.message.content : '';
  if (text.trim()) content.push({ type: 'text', text });
  for (const c of choice.message.tool_calls ?? []) {
    let input;
    try {
      input = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
    } catch {
      throw new Error(`The model called "${c.function?.name}" with arguments that are not JSON.`);
    }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
  }
  const u = json.usage ?? {};
  return {
    id: json.id,
    type: 'message',
    role: 'assistant',
    model: json.model || model,
    content,
    stop_reason: content.some((b) => b.type === 'tool_use')
      ? 'tool_use'
      : (STOP[choice.finish_reason] ?? 'end_turn'),
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
