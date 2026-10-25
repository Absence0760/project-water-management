// Loads the CloudFront Functions in infra/s3_cloudfront.tf as runnable code:
// each aws_cloudfront_function's <<-EOT heredoc is extracted and evaluated,
// so its handler can be called with viewer-request events. Used by the tests
// here (cloudfront-functions.test.mjs) and by the e2e site server
// (e2e/support/site.ts), which routes requests through spa_rewrite itself so
// e2e sees the same 200s and 404s as production. Needs node only.
import { readFileSync } from 'node:fs';

const TF = new URL('../s3_cloudfront.tf', import.meta.url);

/** The code of one aws_cloudfront_function, with the heredoc's indent removed. */
export function functionCode(name, source = readFileSync(TF, 'utf8')) {
	const m = new RegExp(`resource "aws_cloudfront_function" "${name}" \\{[\\s\\S]*?code\\s*=\\s*<<-EOT\\n([\\s\\S]*?)\\n\\s*EOT`).exec(source);
	if (!m) throw new Error(`no aws_cloudfront_function "${name}" with a <<-EOT code block`);
	const lines = m[1].split('\n');
	const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
	return lines.map((l) => l.slice(indent)).join('\n');
}

/**
 * Evaluate a function's code; returns its handler and the named top-level vars.
 * `tf` fills the Terraform interpolations the code carries, as Terraform would
 * (`{ 'var.domain_name': 'example.org' }` for `${var.domain_name}`); one left
 * unfilled stays as its literal text.
 */
export function loadFunction(name, vars = [], tf = {}) {
	let code = functionCode(name);
	for (const [ref, value] of Object.entries(tf)) code = code.replaceAll(`\${${ref}}`, value);
	return new Function(`${code}\nreturn { handler: handler, ${vars.map((v) => `${v}: ${v}`).join(', ')} };`)();
}

/**
 * A viewer-request `request` for `target` (a path with an optional query, as
 * on the request line), shaped as CloudFront hands it to a runtime 2.0
 * function: `querystring` holds each value still encoded, a repeated name's
 * values in order under `multiValue`; `rawQueryString()` returns the query
 * exactly as sent, without the '?' ('' for a bare '?', undefined for none).
 * CloudFront doesn't keep the order of distinct names in `querystring`
 * (observed live 2026-10-25), so this model lists them sorted: code that
 * rebuilt a query from it would reorder it here too.
 */
export function viewerRequest(target, headers = {}) {
	const q = target.indexOf('?');
	const raw = q === -1 ? undefined : target.slice(q + 1);
	const byName = new Map();
	for (const part of raw ? raw.split('&') : []) {
		if (!part) continue;
		const eq = part.indexOf('=');
		const name = eq === -1 ? part : part.slice(0, eq);
		const value = eq === -1 ? '' : part.slice(eq + 1);
		byName.set(name, [...(byName.get(name) ?? []), { value }]);
	}
	const querystring = {};
	for (const name of [...byName.keys()].sort()) {
		const values = byName.get(name);
		querystring[name] = values.length > 1 ? { value: values[0].value, multiValue: values } : values[0];
	}
	return {
		method: 'GET',
		uri: q === -1 ? target : target.slice(0, q),
		querystring,
		headers,
		cookies: {},
		rawQueryString: () => raw
	};
}
