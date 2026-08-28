const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_TOKEN_COUNT,
  MAX_USAGE_EVENT_BYTES,
  createCodexJsonlUsageCollector,
  isCodexJsonExecution,
  normalizeCodexTurnUsage,
} = require('../src/usage-telemetry');

const validEvent = () => ({
  type: 'turn.completed',
  usage: {
    input_tokens: 120,
    cached_input_tokens: 40,
    output_tokens: 30,
  },
});

test('Codex JSONL usage accepts only the allowlisted completed-turn schema', () => {
  assert.deepEqual(normalizeCodexTurnUsage(validEvent()), {
    provider: 'openai',
    input_tokens: 120,
    output_tokens: 30,
    cached_tokens: 40,
    total_tokens: 150,
    source: 'codex_exec_jsonl',
    marrow_intervention: 'governed_runner_usage_capture',
  });

  const rejected = [
    { ...validEvent(), prompt: 'do not collect me' },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    { type: 'turn.completed', usage: { ...validEvent().usage, total_tokens: 150 } },
    { type: 'turn.completed', usage: { ...validEvent().usage, input_tokens: -1 } },
    { type: 'turn.completed', usage: { ...validEvent().usage, output_tokens: 1.5 } },
    { type: 'turn.completed', usage: { ...validEvent().usage, input_tokens: MAX_TOKEN_COUNT + 1 } },
    { type: 'turn.completed', usage: { ...validEvent().usage, cached_input_tokens: 121 } },
    { type: 'item.completed', usage: validEvent().usage },
    { type: 'turn.completed', usage: null },
  ];
  for (const event of rejected) assert.equal(normalizeCodexTurnUsage(event), null);
});

test('Codex JSONL collector handles chunk boundaries and rejects duplicate usage', () => {
  const line = `${JSON.stringify(validEvent())}\n`;
  const collector = createCodexJsonlUsageCollector();
  collector.write(line.slice(0, 17));
  collector.write(line.slice(17));
  assert.equal(collector.finish().total_tokens, 150);

  const duplicate = createCodexJsonlUsageCollector();
  duplicate.write(line);
  duplicate.write(line);
  assert.equal(duplicate.finish(), null);
});

test('Codex JSONL collector accepts reordered root keys and rejects reordered duplicates', () => {
  const reorderedEvent = {
    usage: validEvent().usage,
    type: 'turn.completed',
  };
  const reorderedLine = `${JSON.stringify(reorderedEvent)}\n`;

  const single = createCodexJsonlUsageCollector();
  single.write(reorderedLine);
  assert.equal(single.finish().total_tokens, 150);

  const duplicate = createCodexJsonlUsageCollector();
  duplicate.write(`${JSON.stringify(validEvent())}\n`);
  duplicate.write(reorderedLine);
  assert.equal(duplicate.finish(), null);
});

test('Codex JSONL collector rejects a completed duplicate hidden after the size boundary', () => {
  const oversizedReorderedEvent = {
    usage: validEvent().usage,
    padding: 'x'.repeat(MAX_USAGE_EVENT_BYTES),
    type: 'turn.completed',
  };
  const collector = createCodexJsonlUsageCollector();
  collector.write(`${JSON.stringify(validEvent())}\n`);
  collector.write(`${JSON.stringify(oversizedReorderedEvent)}\n`);
  assert.equal(collector.finish(), null);
});

test('Codex JSONL collector discards non-usage event text without retaining it', () => {
  const collector = createCodexJsonlUsageCollector();
  collector.write(`${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'raw-prompt-completion-must-not-be-collected'.repeat(500) },
  })}\n`);
  assert.equal(collector.bufferedBytes(), 0);
  collector.write(`${JSON.stringify(validEvent())}\n`);
  const usage = collector.finish();
  assert.equal(JSON.stringify(usage).includes('raw-prompt'), false);
  assert.equal(usage.total_tokens, 150);
});

test('usage capture activates only for direct structured Codex exec', () => {
  assert.equal(isCodexJsonExecution(['codex', 'exec', '--json', 'inspect']), true);
  assert.equal(isCodexJsonExecution(['/usr/local/bin/codex', 'exec', 'inspect', '--json']), true);
  assert.equal(isCodexJsonExecution(['codex', 'exec', 'inspect', '--json', '--', '--json']), true);
  assert.equal(isCodexJsonExecution(['codex', 'exec', 'inspect']), false);
  assert.equal(isCodexJsonExecution(['codex', 'exec', '--', '--json']), false);
  assert.equal(isCodexJsonExecution(['codex', 'exec', 'inspect', '--', '--json']), false);
  assert.equal(isCodexJsonExecution(['codex', '--json', 'inspect']), false);
  assert.equal(isCodexJsonExecution(['node', 'codex', 'exec', '--json']), false);
});
