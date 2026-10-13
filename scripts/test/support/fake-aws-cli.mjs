// A stand-in for the `aws` executable in tests: it records each call and
// prints a canned response. FAKE_AWS_DIR holds responses.json, keyed by
// "<service> <operation>": one response or a list used in order (the
// last one repeats). A response is { stdout, stderr, status }; a stdout
// that is not a string is printed as JSON. Each call is appended to
// calls.jsonl with its argv and the AWS_ variables it saw.

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_AWS_DIR;
const args = process.argv.slice(2);
const op = `${args[0]} ${args[1]}`;
const callsFile = path.join(dir, 'calls.jsonl');
let earlier = 0;
try {
  earlier = readFileSync(callsFile, 'utf8').split('\n').filter((l) => l && JSON.parse(l).op === op).length;
} catch {
  // first call
}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('AWS_')));
appendFileSync(callsFile, `${JSON.stringify({ op, args, env })}\n`);

const responses = JSON.parse(readFileSync(path.join(dir, 'responses.json'), 'utf8'));
let r = responses[op];
if (Array.isArray(r)) r = r[Math.min(earlier, r.length - 1)];
if (r === undefined) {
  process.stderr.write(`fake aws: no response for ${op}\n`);
  process.exit(255);
}
if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout));
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 0);
