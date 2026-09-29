#!/usr/bin/env node
// A fake `aws` CLI for preapply-check.test.mjs and postapply-check.test.mjs:
// only the read-only calls those scripts make, answered from a JSON state
// file (FAKE_AWS_STATE) keyed "<service> <op>". A value is either the JSON to
// print, { "error": "…" } to fail as the CLI does, or { "byRegion": {…} } /
// { "byArg": "--flag", "values": {…} } to vary by region or by one argument.
// Every call is appended to FAKE_AWS_LOG as a JSON line. A call the state
// doesn't know fails loudly, so an unexpected (or changing) call can't pass
// unnoticed.
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const global = {};
while (argv[0]?.startsWith('--')) global[argv.shift()] = argv.shift();
const [service, op, ...rest] = argv;
const args = {};
for (let i = 0; i < rest.length; i++) {
	const k = rest[i];
	const next = rest[i + 1];
	if (next === undefined || next.startsWith('--')) args[k] = true;
	else args[k] = rest[++i];
}
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify({ service, op, args, global }) + '\n');

const fail = (msg) => {
	process.stderr.write(`\nAn error occurred ${msg}\n`);
	process.exit(254);
};
const state = JSON.parse(readFileSync(process.env.FAKE_AWS_STATE, 'utf8'));
let v = state[`${service} ${op}`];
if (v === undefined) fail(`(FakeUnknownCall) no fake for aws ${service} ${op}`);
if (v.byRegion) v = v.byRegion[global['--region']];
else if (v.byArg) v = v.values[args[v.byArg]];
if (v === undefined) fail(`(NotFound) no fake answer for aws ${service} ${op} here`);
if (v.error) fail(v.error);
process.stdout.write(JSON.stringify(v) + '\n');
