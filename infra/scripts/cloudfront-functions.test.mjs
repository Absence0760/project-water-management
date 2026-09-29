// The CloudFront Functions in infra/s3_cloudfront.tf, run as code: the
// Terraform test (guardrails.tftest.hcl) can only look for strings in them,
// so here each function's heredoc is extracted and its handler called with
// viewer-request events. spa_rewrite's lists of where the build keeps files
// are also checked against the real tree (frontend/static and the
// prerendered routes), both ways: a new static file or prerendered page that
// the function doesn't know would 404 in production only, and a stale entry
// would let a missing file fall through to S3. Needs node only.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const tf = readFileSync(join(root, 'infra/s3_cloudfront.tf'), 'utf8');

/** The code of one aws_cloudfront_function, with the heredoc's indent removed. */
function functionCode(name, source = tf) {
	const m = new RegExp(`resource "aws_cloudfront_function" "${name}" \\{[\\s\\S]*?code\\s*=\\s*<<-EOT\\n([\\s\\S]*?)\\n\\s*EOT`).exec(source);
	if (!m) throw new Error(`no aws_cloudfront_function "${name}" with a <<-EOT code block`);
	const lines = m[1].split('\n');
	const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
	return lines.map((l) => l.slice(indent)).join('\n');
}

/** Evaluate a function's code; returns its handler and the named top-level vars. */
function load(name, vars = []) {
	return new Function(`${functionCode(name)}\nreturn { handler: handler, ${vars.map((v) => `${v}: ${v}`).join(', ')} };`)();
}

const spa = load('spa_rewrite', ['STATIC_DIRS', 'STATIC_FILES']);
const viewerRequest = (uri) => ({ request: { method: 'GET', uri, querystring: {}, headers: {}, cookies: {} }, viewer: { ip: '198.51.100.7' } });
/** What the viewer gets: the URI sent to S3, or the function's own status. */
const outcome = (uri) => {
	const r = spa.handler(viewerRequest(uri));
	return 'statusCode' in r ? r.statusCode : r.uri;
};

test('SPA routes (no extension) are served index.html', () => {
	for (const uri of ['/', '/projects/abc', '/projects/abc/', '/login', '/_app', '/help/', '//', '/a.b/c']) {
		assert.equal(outcome(uri), '/index.html', uri);
	}
});

test('the prerendered pages are served from their own HTML', () => {
	for (const p of ['welcome', 'privacy', 'terms', 'methods']) assert.equal(outcome(`/${p}`), `/${p}.html`);
});

test("the build's files go to S3 unchanged", () => {
	for (const uri of ['/_app/immutable/entry/start.abc123.js', '/_app/version.json', '/fonts/outfit-600.woff2', '/help/dam-400.webp', '/landing/contours.svg', '/favicon.ico', '/robots.txt', '/index.html', '/welcome.html']) {
		assert.equal(outcome(uri), uri, uri);
	}
});

test('a file the build does not have gets a 404 page from the function, not S3 XML', () => {
	for (const uri of ['/report.pdf', '/projects/abc/export.xlsx', '/wp-login.php', '/.env', '/.git/HEAD.lock', '//favicon.ico', '/static/x.js', '/favicon.ico.bak']) {
		assert.equal(outcome(uri), 404, uri);
	}
	const r = spa.handler(viewerRequest('/report.pdf'));
	assert.equal(r.headers['content-type'].value, 'text/html; charset=utf-8');
	assert.equal(r.headers['cache-control'].value, 'no-store');
	assert.equal(r.body.encoding, 'text');
	assert.match(r.body.data, /<title>Page not found<\/title>/);
	assert.match(r.body.data, /href="\/"/);
	assert.doesNotMatch(r.body.data, /<script|<style|style=/, 'the page must pass the site CSP as it is');
	// Well under CloudFront Functions' 10 KB code limit.
	assert.ok(Buffer.byteLength(functionCode('spa_rewrite')) < 8 * 1024);
});

test('dot segments never reach S3 (no path can resolve to the bucket root, where ListBucket would list)', () => {
	for (const uri of ['/.', '/..', '/_app/..', '/_app/../index.html', '/help/./dam-400.webp', '/./']) {
		assert.equal(outcome(uri), 404, uri);
	}
});

// --- The lists against the real tree ----------------------------------------

const staticDir = join(root, 'frontend/static');
const staticEntries = readdirSync(staticDir);
const staticDirs = staticEntries.filter((e) => statSync(join(staticDir, e)).isDirectory());
const staticFiles = staticEntries.filter((e) => statSync(join(staticDir, e)).isFile());
const routesDir = join(root, 'frontend/src/routes');
const prerendered = readdirSync(routesDir).filter((d) => {
	try {
		return /export const prerender = true/.test(readFileSync(join(routesDir, d, '+page.ts'), 'utf8'));
	} catch {
		return false;
	}
});

test('every file and directory in frontend/static is served', () => {
	for (const d of staticDirs) assert.ok(spa.STATIC_DIRS.includes(d), `frontend/static/${d}/ is missing from spa_rewrite's STATIC_DIRS (infra/s3_cloudfront.tf)`);
	for (const f of staticFiles) assert.ok(spa.STATIC_FILES.includes(f), `frontend/static/${f} is missing from spa_rewrite's STATIC_FILES (infra/s3_cloudfront.tf)`);
});

test('every prerendered page is mapped and served', () => {
	assert.ok(prerendered.length >= 4, `found the prerendered routes (${prerendered})`);
	for (const p of prerendered) {
		assert.equal(outcome(`/${p}`), `/${p}.html`, `/${p} must be served from ${p}.html`);
		assert.ok(spa.STATIC_FILES.includes(`${p}.html`), `${p}.html is missing from STATIC_FILES`);
	}
});

test('no stale entries: each listed location is something the build writes', () => {
	for (const d of spa.STATIC_DIRS) assert.ok(d === '_app' || staticDirs.includes(d), `STATIC_DIRS has ${d}, which the build doesn't write`);
	for (const f of spa.STATIC_FILES) {
		assert.ok(f === 'index.html' || staticFiles.includes(f) || prerendered.includes(f.replace(/\.html$/, '')), `STATIC_FILES has ${f}, which the build doesn't write`);
	}
});

// --- api_strip_prefix ---------------------------------------------------------

test('api_strip_prefix strips /api and overwrites the viewer address', () => {
	const api = load('api_strip_prefix');
	const e = viewerRequest('/api/auth/login');
	e.request.headers['x-viewer-address'] = { value: '203.0.113.1' }; // forged by the viewer
	const r = api.handler(e);
	assert.equal(r.uri, '/auth/login');
	assert.equal(r.headers['x-viewer-address'].value, '198.51.100.7');
	assert.equal(api.handler(viewerRequest('/api')).uri, '/');
	assert.equal(api.handler(viewerRequest('/api/')).uri, '/');
});
