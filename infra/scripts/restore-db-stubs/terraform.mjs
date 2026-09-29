#!/usr/bin/env node
// A fake `terraform` for restore-db.test.mjs. Every call is appended to
// FAKE_TF_LOG as a JSON line (with the AWS_PROFILE it ran under, and the
// names of the TF_VAR_* it was given, never their values).
// `output -raw <name>` answers from the FAKE_TF_OUTPUTS JSON file; `plan`
// prints FAKE_TF_PLAN (or an in-place-only plan); `apply` fails the test,
// since the script must never apply.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('-chdir='));
const tfvars = Object.keys(process.env)
	.filter((k) => k.startsWith('TF_VAR_'))
	.sort();
appendFileSync(process.env.FAKE_TF_LOG, JSON.stringify({ args, profile: process.env.AWS_PROFILE, tfvars }) + '\n');

const [cmd, ...rest] = args;
if (cmd === 'output' && rest[0] === '-raw') {
	const outputs = JSON.parse(readFileSync(process.env.FAKE_TF_OUTPUTS, 'utf8'));
	if (!(rest[1] in outputs)) {
		process.stderr.write(`Error: Output "${rest[1]}" not found\n`);
		process.exit(1);
	}
	process.stdout.write(outputs[rest[1]]);
} else if (cmd === 'state' || cmd === 'import') {
	process.stdout.write(`fake terraform ${cmd}: ok\n`);
} else if (cmd === 'plan') {
	process.stdout.write(
		(process.env.FAKE_TF_PLAN ??
			'  # aws_lambda_function.migrate will be updated in-place\nPlan: 0 to add, 3 to change, 0 to destroy.') + '\n',
	);
} else {
	process.stderr.write(`fake terraform: unexpected call: ${args.join(' ')}\n`);
	process.exit(99);
}
