import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createDatabase } from '../db/index.js';
import { AppError } from '../errors.js';
import { createOwner } from '../modules/identity/index.js';

/**
 * `pnpm --filter @tradex/api user:create-owner [--username <name>] [--display-name <text>] [--additional]`
 *
 * Interactive: asks for the username (unless given) and the password twice with hidden input.
 * Connects with DATABASE_URL (the tradex_app role; creating a user needs DML only).
 * Test mode (NODE_ENV=test, never in production) reads username, password and confirmation as three
 * lines from stdin instead, so a scripted test can drive it. The password is never accepted as an
 * argument or environment variable, and is never printed.
 */

const TEST_MODE = process.env.NODE_ENV === 'test';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Read `count` lines from piped stdin (test mode). */
async function readStdinLines(count: number): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
    if (lines.length === count) break;
  }
  rl.close();
  if (lines.length < count) fail('Expected username, password and confirmation on stdin.');
  return lines;
}

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Mute echo of typed characters; the prompt itself is written before muting takes effect.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stdout.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      'display-name': { type: 'string' },
      additional: { type: 'boolean', default: false },
    },
    strict: true,
  });

  let username = values.username;
  let password: string;
  if (TEST_MODE) {
    const wantUsername = username === undefined;
    const lines = await readStdinLines(wantUsername ? 3 : 2);
    if (wantUsername) username = lines.shift();
    const [first, second] = lines;
    if (first !== second) fail('Passwords do not match.');
    password = first ?? '';
  } else {
    if (!process.stdin.isTTY) {
      fail('An interactive terminal is required (the password is never read from a pipe).');
    }
    username ??= await ask('Username: ', false);
    password = await ask('Password: ', true);
    const confirmation = await ask('Confirm password: ', true);
    if (password !== confirmation) fail('Passwords do not match.');
  }

  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set (see apps/api/.env.example).');

  const db = createDatabase(url);
  try {
    const user = await createOwner(db, {
      username: username ?? '',
      displayName: values['display-name'] ?? username ?? '',
      password,
      additional: values.additional,
    });
    console.log(`Created OWNER user "${user.username}" (${user.id}).`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  // AppError messages are written for the operator and never contain the password or the hash.
  if (err instanceof AppError) {
    console.error(err.message);
  } else {
    console.error(
      'Failed to create the owner:',
      err instanceof Error ? err.message : 'unknown error',
    );
  }
  process.exit(1);
});
