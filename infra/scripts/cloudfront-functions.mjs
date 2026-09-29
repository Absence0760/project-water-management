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

/** Evaluate a function's code; returns its handler and the named top-level vars. */
export function loadFunction(name, vars = []) {
	return new Function(`${functionCode(name)}\nreturn { handler: handler, ${vars.map((v) => `${v}: ${v}`).join(', ')} };`)();
}
