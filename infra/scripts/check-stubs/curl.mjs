#!/usr/bin/env node
// A fake `curl` for postapply-check.test.mjs: answers `curl … -o <file>
// -w '%{http_code}' <url>` from FAKE_CURL_STATE, a JSON map of URL →
// { "status": n, "body": "…" } (a URL it doesn't know gets 200 and the
// SPA's index.html; { "error": "…" } fails as a connection error does).
// Every call is appended to FAKE_CURL_LOG with all its arguments.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify(argv) + '\n');
let outFile = null;
let url = null;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '-o') outFile = argv[++i];
	else if (a === '-w' || a === '--max-time' || a === '-H') i++;
	else if (!a.startsWith('-')) url = a;
}
const state = JSON.parse(readFileSync(process.env.FAKE_CURL_STATE, 'utf8'));
const r = state[url] ?? { status: 200, body: '<!doctype html><title>index</title>' };
if (r.error) {
	process.stdout.write('000');
	process.stderr.write(`curl: (7) ${r.error}\n`);
	process.exit(7);
}
if (outFile) writeFileSync(outFile, r.body ?? '');
process.stdout.write(String(r.status));
