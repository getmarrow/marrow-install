const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_USAGE_EVENT_BYTES = 4_096;
const CODEX_USAGE_KEYS = new Set([
  'cached_input_tokens',
  'input_tokens',
  'output_tokens',
]);

function isBoundedTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_COUNT;
}

function exactKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function normalizeCodexTurnUsage(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (!exactKeys(event, new Set(['type', 'usage'])) || event.type !== 'turn.completed') return null;

  const usage = event.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  if (!exactKeys(usage, CODEX_USAGE_KEYS)) return null;

  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cachedTokens = usage.cached_input_tokens;
  if (![inputTokens, outputTokens, cachedTokens].every(isBoundedTokenCount)) return null;
  if (cachedTokens > inputTokens) return null;

  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens > MAX_TOKEN_COUNT) return null;

  return {
    provider: 'openai',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_tokens: cachedTokens,
    total_tokens: totalTokens,
    source: 'codex_exec_jsonl',
    marrow_intervention: 'governed_runner_usage_capture',
  };
}

function isCodexJsonExecution(command) {
  if (!Array.isArray(command) || command.length < 3) return false;
  const executable = path.basename(String(command[0] || '')).toLowerCase().replace(/\.exe$/, '');
  const execArgs = command.slice(2);
  const terminatorIndex = execArgs.indexOf('--');
  const optionArgs = terminatorIndex === -1 ? execArgs : execArgs.slice(0, terminatorIndex);
  return executable === 'codex'
    && command[1] === 'exec'
    && optionArgs.includes('--json');
}

function createCodexJsonlUsageCollector() {
  const decoder = new StringDecoder('utf8');
  let line = '';
  let discardLine = false;
  let acceptedUsage = null;
  let usageEventCount = 0;
  let invalidUsageEvent = false;

  const resetLine = () => {
    line = '';
    discardLine = false;
  };

  const finishLine = () => {
    if (discardLine || !line.trim()) {
      resetLine();
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (/"type"\s*:\s*"turn\.completed"/.test(line)) invalidUsageEvent = true;
      resetLine();
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.type !== 'turn.completed') {
      resetLine();
      return;
    }

    usageEventCount += 1;
    const normalized = normalizeCodexTurnUsage(parsed);
    if (!normalized || usageEventCount !== 1) invalidUsageEvent = true;
    else acceptedUsage = normalized;
    resetLine();
  };

  const consume = (text) => {
    for (const character of text) {
      if (character === '\n') {
        finishLine();
        continue;
      }
      if (discardLine) continue;
      if (line.length >= MAX_USAGE_EVENT_BYTES) {
        if (/"type"\s*:\s*"turn\.completed"/.test(line)) {
          invalidUsageEvent = true;
          usageEventCount += 1;
        }
        discardLine = true;
        line = '';
        continue;
      }
      line += character;
    }
  };

  return {
    write(chunk) {
      consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    },
    finish() {
      consume(decoder.end());
      if (line || discardLine) finishLine();
      return invalidUsageEvent || usageEventCount !== 1 ? null : acceptedUsage;
    },
    bufferedBytes() {
      return Buffer.byteLength(line, 'utf8');
    },
  };
}

function createHostUsageCapture(command) {
  if (!isCodexJsonExecution(command)) {
    return {
      supported: false,
      write() {},
      finish() { return null; },
    };
  }
  const collector = createCodexJsonlUsageCollector();
  return {
    supported: true,
    write: (chunk) => collector.write(chunk),
    finish: () => collector.finish(),
  };
}

module.exports = {
  MAX_TOKEN_COUNT,
  createCodexJsonlUsageCollector,
  createHostUsageCapture,
  isCodexJsonExecution,
  normalizeCodexTurnUsage,
};
