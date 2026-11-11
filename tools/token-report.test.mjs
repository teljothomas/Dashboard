import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs, analyse, formatTable } from './token-report.mjs';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-session.jsonl');

test('sums usage, de-duplicates message ids, counts malformed lines', async () => {
  const r = await analyse([fixture]);
  assert.equal(r.malformed, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.messages, 3);
  // msg_A counted once with its highest output_tokens (20)
  assert.equal(r.totals.input_tokens, 13);
  assert.equal(r.totals.cache_creation_input_tokens, 100);
  assert.equal(r.totals.cache_read_input_tokens, 6000);
  assert.equal(r.totals.output_tokens, 57);
  assert.equal(r.totals.all_input, 6113);
});

test('counts Read calls and repeated reads, ignores other tools', async () => {
  const r = await analyse([fixture]);
  assert.equal(r.reads.total, 3);
  assert.equal(r.reads.unique, 2);
  assert.equal(r.reads.repeat_reads, 1);
  assert.deepEqual(r.reads.repeated, [{ path: '/p/a.md', count: 2 }]);
});

test('--since / --until filter by timestamp', async () => {
  const r = await analyse([fixture], { since: '2026-11-11T09:01:30Z' });
  assert.equal(r.messages, 1);
  assert.equal(r.totals.output_tokens, 7);
  const r2 = await analyse([fixture], { until: '2026-11-11T09:00:30Z' });
  assert.equal(r2.messages, 1);
});

test('--session filters by session id', async () => {
  const none = await analyse([fixture], { session: 'other' });
  assert.equal(none.messages, 0);
  const some = await analyse([fixture], { session: 's1' });
  assert.equal(some.messages, 3);
});

test('output never contains message content', async () => {
  const r = await analyse([fixture]);
  const text = formatTable(r) + JSON.stringify(r);
  assert.ok(!text.includes('SECRET-'));
});

test('parseArgs validates input', () => {
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--session', 'x']).session, 'x');
  assert.throws(() => parseArgs(['--bogus']));
  assert.throws(() => parseArgs(['--since']));
  assert.throws(() => parseArgs(['--since', 'not-a-date']));
});
