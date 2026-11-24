'use strict';

// `marrow-install verify <answer-file> --jwks <jwks-file> --account <id> [--environment <env>] [--json]`: checks a saved
// signed export answer against a saved key list, offline. No network, no environment variable, no account default from
// the answer. Output holds fixed codes and verified values only, never a line of either file.

const fs = require('fs');
const { verifySignedRecords, strictParse, SIGNED_EXPORT_MAX_BYTES } = require('./signed-record-verify');

const FLAGS = { '--jwks': true, '--account': true, '--environment': true, '--json': false };
const ACCOUNT = /^[A-Za-z0-9._:-]{1,128}$/;
const SHOWN = /^[A-Za-z0-9._:+-]+$/;
const USAGE = `Usage:
  npx @getmarrow/install verify <answer-file> --jwks <jwks-file> --account <account-id> [--environment production|staging|development|test] [--json]
Checks offline that a saved signed export answer was signed by a key in the saved key list, for the account you name.
The environment defaults to production. Exit 0 verified, 1 not verified, 2 usage error, 3 unreadable input file.
`;

function parseVerifyArgs(argv) {
  const values = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (!Object.hasOwn(FLAGS, name) || Object.hasOwn(values, name) || (!FLAGS[name] && equals !== -1)) return null;
    const value = !FLAGS[name] ? true : equals === -1 ? argv[++index] : arg.slice(equals + 1);
    if (value !== true && (typeof value !== 'string' || value === '' || value.startsWith('--'))) return null;
    values[name] = value;
  }
  const environment = values['--environment'] ?? 'production';
  if (positionals.length !== 1 || !values['--jwks'] || !ACCOUNT.test(values['--account'] ?? '')) return null;
  if (!['production', 'staging', 'development', 'test'].includes(environment)) return null;
  return { answerPath: positionals[0], jwksPath: values['--jwks'], account: values['--account'], environment, json: values['--json'] === true };
}

/** A regular file (a final symlink is not followed), at most `max` bytes, decoded as UTF-8 with fatal errors and the BOM kept. */
function readInput(file, max) {
  let fd;
  let length = 0;
  const buffer = Buffer.alloc(max + 1);
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return { code: 'input_file' };
    for (let read = 1; read > 0 && length <= max; length += read) read = fs.readSync(fd, buffer, length, max + 1 - length, null);
  } catch {
    return { code: 'input_file' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (length > max) return { code: 'input_file' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)) };
  } catch {
    return { code: 'input_utf8' };
  }
}

function report(options, failures, records) {
  const shown = (name) => [...new Set(records.map((record) => String(record[name])))].map((value) => (SHOWN.test(value) ? value : '?')).join(',');
  if (options.json) process.stdout.write(`${JSON.stringify(records ? { ok: true, failures, records } : { ok: false, failures })}\n`);
  else if (records) process.stdout.write(`VERIFIED ${records.length} record(s) kid=${shown('kid')} signed_at=${shown('signed_at')}\n`);
  else process.stdout.write(`NOT VERIFIED ${failures.join(',')}\n`);
}

async function runVerifyCli(argv) {
  const options = parseVerifyArgs(argv);
  if (!options) { process.stderr.write(USAGE); return 2; }
  const answer = readInput(options.answerPath, SIGNED_EXPORT_MAX_BYTES);
  const keys = answer.code ? answer : readInput(options.jwksPath, 65536);
  if (keys.code) { report(options, [keys.code]); return 3; }
  let jwks;
  try {
    jwks = strictParse(keys.text);
  } catch {
    report(options, ['jwks_parse']);
    return 1;
  }
  const result = await verifySignedRecords(answer.text, jwks, { account_id: options.account, environment: options.environment });
  report(options, result.failures, result.ok === true ? result.records : undefined);
  return result.ok === true ? 0 : 1;
}

function main(argv) {
  runVerifyCli(argv).then((code) => { process.exitCode = code; }, () => { process.stderr.write('marrow-install verify failed\n'); process.exitCode = 1; });
}

module.exports = { main, runVerifyCli, parseVerifyArgs };
