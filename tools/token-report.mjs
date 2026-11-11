#!/usr/bin/env node
// token-report.mjs — read-only token usage report over Claude Code transcripts (WP-00.3).
// Node >= 24, no dependencies. Never prints message content: only counts, ids and file paths of Read calls.
//
// Confirmed field paths (inspected keys only, 2026-11-11, real transcript):
//   line.type === "assistant"
//   line.timestamp (ISO string), line.sessionId
//   line.message.id                      -> de-dupe key (one assistant message is split over several lines,
//                                           each repeating the same usage)
//   line.message.usage.input_tokens | cache_creation_input_tokens | cache_read_input_tokens | output_tokens
//   line.message.content[] items         -> { type: "tool_use", id, name: "Read", input: { file_path } }
//
// Usage: node tools/token-report.mjs [--dir <path>] [--since <ISO>] [--until <ISO>] [--session <id>] [--json]

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DIR = join(homedir(), '.claude', 'projects', 'C--Users-teljo-Projects-TradeX-Dashboard');
const USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

export function parseArgs(argv) {
  const opts = { dir: DEFAULT_DIR, since: null, until: null, session: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (['--dir', '--since', '--until', '--session'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      opts[a.slice(2)] = v;
    } else throw new Error(`unknown option ${a}`);
  }
  for (const k of ['since', 'until']) {
    if (opts[k] !== null && Number.isNaN(Date.parse(opts[k]))) throw new Error(`invalid --${k} date`);
  }
  return opts;
}

export async function listFiles(dir, session) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  return names
    .filter((n) => !session || basename(n, '.jsonl') === session)
    .map((n) => join(dir, n));
}

export async function analyse(files, { since = null, until = null, session = null } = {}) {
  const sinceMs = since ? Date.parse(since) : -Infinity;
  const untilMs = until ? Date.parse(until) : Infinity;
  const messages = new Map(); // message.id -> usage (max output_tokens wins)
  const toolUses = new Map(); // tool_use id -> file path (Read only)
  let lines = 0, malformed = 0, duplicates = 0;

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      lines++;
      let o;
      try { o = JSON.parse(raw); } catch { malformed++; continue; }
      if (!o || o.type !== 'assistant' || !o.message) continue;
      if (session && o.sessionId !== undefined && o.sessionId !== session) continue;
      const ts = Date.parse(o.timestamp);
      if (!Number.isNaN(ts) && (ts < sinceMs || ts > untilMs)) continue;

      const m = o.message;
      const content = Array.isArray(m.content) ? m.content : [];
      for (const c of content) {
        if (c && c.type === 'tool_use' && c.name === 'Read' && c.input && typeof c.input.file_path === 'string') {
          toolUses.set(c.id ?? `${m.id}:${toolUses.size}`, c.input.file_path);
        }
      }
      if (!m.usage || typeof m.id !== 'string') continue;
      const prev = messages.get(m.id);
      if (prev) {
        duplicates++;
        if ((m.usage.output_tokens ?? 0) <= (prev.output_tokens ?? 0)) continue;
      }
      messages.set(m.id, m.usage);
    }
  }

  const totals = Object.fromEntries(USAGE_KEYS.map((k) => [k, 0]));
  for (const u of messages.values()) for (const k of USAGE_KEYS) totals[k] += Number(u[k]) || 0;

  const readCounts = new Map();
  for (const p of toolUses.values()) readCounts.set(p, (readCounts.get(p) ?? 0) + 1);
  const repeated = [...readCounts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([path, count]) => ({ path, count }));
  const totalReads = [...readCounts.values()].reduce((a, b) => a + b, 0);
  const repeatReads = repeated.reduce((a, r) => a + r.count - 1, 0);

  return {
    files: files.length, lines, malformed, duplicates,
    messages: messages.size,
    totals: { ...totals, all_input: totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens },
    reads: { total: totalReads, unique: readCounts.size, repeat_reads: repeatReads, repeated },
  };
}

export function formatTable(r) {
  const t = r.totals;
  const out = [
    `files ${r.files} | lines ${r.lines} | malformed ${r.malformed} | duplicate-lines ${r.duplicates} | messages ${r.messages}`,
    `input_tokens               ${t.input_tokens}`,
    `cache_creation_input       ${t.cache_creation_input_tokens}`,
    `cache_read_input           ${t.cache_read_input_tokens}`,
    `all input (incl. cache)    ${t.all_input}`,
    `output_tokens              ${t.output_tokens}`,
    `Read calls ${r.reads.total} | unique files ${r.reads.unique} | repeat reads ${r.reads.repeat_reads}`,
  ];
  for (const x of r.reads.repeated.slice(0, 10)) out.push(`  ${x.count}x ${x.path}`);
  return out.join('\n');
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  let files;
  try { files = await listFiles(opts.dir, opts.session); } catch (e) { console.error(`cannot read dir: ${e.code ?? e.message}`); process.exit(1); }
  const report = await analyse(files, opts);
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatTable(report));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
