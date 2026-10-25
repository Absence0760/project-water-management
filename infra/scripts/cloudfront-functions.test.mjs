// The CloudFront Functions in infra/s3_cloudfront.tf, run as code: the
// Terraform test (guardrails.tftest.hcl) can only look for strings in them,
// so here each function's heredoc is extracted (cloudfront-functions.mjs, which the
// e2e site server also routes through) and its handler called with
// viewer-request events. spa_rewrite's lists of where the build keeps files
// are also checked against the real tree (frontend/static and the
// prerendered routes), both ways: a new static file or prerendered page that
// the function doesn't know would 404 in production only, and a stale entry
// would let a missing file fall through to S3. Needs node only.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { functionCode, loadFunction, viewerRequest as cfRequest } from './cloudfront-functions.mjs';

const root = new URL('../..', import.meta.url).pathname;
const SITE = 'icwbt.jaredhoward.com';
const spa = loadFunction('spa_rewrite', ['PRERENDERED', 'STATIC_DIRS', 'STATIC_FILES', 'SITE_HOST'], { 'var.domain_name': SITE });
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
	for (const p of ['welcome', 'welcome/af', 'privacy', 'terms', 'methods', 'data-sources']) assert.equal(outcome(`/${p}`), `/${p}.html`);
});

test('a landing page in a language the build has not written is the SPA, and its HTML is not served directly (issue #137)', () => {
	for (const uri of ['/welcome/en', '/welcome/xx', '/welcome/af/x']) assert.equal(outcome(uri), '/index.html', uri);
	assert.equal(outcome('/welcome/af.html'), 404);
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
// Every language but the default gets its own landing page, /welcome/<code>
// (the `locale` param matcher, frontend/src/params/locale.ts; issue #137).
const { LANGUAGES, DEFAULT_LOCALE } = await import(join(root, 'packages/engine/src/languages.ts'));
const localeParams = LANGUAGES.map((l) => l.code).filter((c) => c !== DEFAULT_LOCALE);
/** The paths a route directory prerenders: `[[lang=locale]]` is none and each non-default language. */
function prerenderedPaths(dir, rel = '') {
	const here = [];
	try {
		if (rel && /export const prerender = true/.test(readFileSync(join(dir, '+page.ts'), 'utf8'))) here.push(rel);
	} catch {
		// no +page.ts here
	}
	const below = readdirSync(dir)
		.filter((d) => statSync(join(dir, d)).isDirectory())
		.flatMap((d) => prerenderedPaths(join(dir, d), `${rel}/${d}`));
	return [...here, ...below].flatMap((p) => {
		const m = /^(.*)\/\[\[lang=locale\]\]$/.exec(p);
		return m ? [m[1], ...localeParams.map((c) => `${m[1]}/${c}`)] : [p];
	});
}
// Without the leading slash: 'welcome', 'welcome/af', 'privacy', …
const prerendered = prerenderedPaths(routesDir).map((p) => p.slice(1));

test('every file and directory in frontend/static is served', () => {
	for (const d of staticDirs) assert.ok(spa.STATIC_DIRS.includes(d), `frontend/static/${d}/ is missing from spa_rewrite's STATIC_DIRS (infra/s3_cloudfront.tf)`);
	for (const f of staticFiles) assert.ok(spa.STATIC_FILES.includes(f), `frontend/static/${f} is missing from spa_rewrite's STATIC_FILES (infra/s3_cloudfront.tf)`);
});

test('every prerendered page is mapped and served', () => {
	assert.ok(prerendered.length >= 5 && prerendered.includes('welcome/af'), `found the prerendered routes (${prerendered})`);
	for (const p of prerendered) {
		assert.equal(outcome(`/${p}`), `/${p}.html`, `/${p} must be served from ${p}.html`);
		// A top-level page's HTML is also served by its own name, like the build's other root files.
		if (!p.includes('/')) assert.ok(spa.STATIC_FILES.includes(`${p}.html`), `${p}.html is missing from STATIC_FILES`);
	}
	assert.deepEqual([...spa.PRERENDERED].sort(), prerendered.map((p) => `/${p}`).sort(), 'PRERENDERED lists exactly the prerendered pages');
});

test('no stale entries: each listed location is something the build writes', () => {
	for (const d of spa.STATIC_DIRS) assert.ok(d === '_app' || staticDirs.includes(d), `STATIC_DIRS has ${d}, which the build doesn't write`);
	for (const f of spa.STATIC_FILES) {
		assert.ok(f === 'index.html' || staticFiles.includes(f) || prerendered.includes(f.replace(/\.html$/, '')), `STATIC_FILES has ${f}, which the build doesn't write`);
	}
});

// --- A former hostname redirects (issue #551) --------------------------------

/** A viewer request with a Host header for a path and query, as CloudFront gives it (cloudfront-functions.mjs). */
const hostRequest = (host, target) => ({ request: cfRequest(target, { host: { value: host } }), viewer: { ip: '198.51.100.7' } });

test('the site host is filled from var.domain_name, the one interpolation in the code', () => {
	assert.equal(spa.SITE_HOST, SITE);
	assert.equal(functionCode('spa_rewrite').match(/\$\{/g).length, 1);
	assert.match(functionCode('spa_rewrite'), /var SITE_HOST = '\$\{var\.domain_name\}';/);
});

test("the site's own host is served as before, whatever its case", () => {
	for (const host of [SITE, 'ICWBT.jaredhoward.com']) {
		assert.equal(spa.handler(hostRequest(host, '/projects/abc')).uri, '/index.html', host);
		assert.equal(spa.handler(hostRequest(host, '/welcome/af')).uri, '/welcome/af.html', host);
		assert.equal(spa.handler(hostRequest(host, '/report.pdf')).statusCode, 404, host);
	}
});

test('any other host gets a 301 to the same path and query on the site host', () => {
	for (const host of ['water-management.jaredhoward.com', 'd111111abcdef8.cloudfront.net', 'evil.example', `${SITE}.`]) {
		const r = spa.handler(hostRequest(host, '/reset-password?token=abc-DEF_123'));
		assert.equal(r.statusCode, 301, host);
		assert.equal(r.statusDescription, 'Moved Permanently');
		// Never the request's own host: no open redirect.
		assert.equal(r.headers.location.value, `https://${SITE}/reset-password?token=abc-DEF_123`, host);
		assert.equal(r.headers['cache-control'].value, 'max-age=3600');
		assert.equal(r.body, undefined);
	}
	const old = 'water-management.jaredhoward.com';
	const location = (target) => spa.handler(hostRequest(old, target)).headers.location.value;
	assert.equal(location('/'), `https://${SITE}/`);
	assert.equal(location('/projects/abc/runs'), `https://${SITE}/projects/abc/runs`);
	// Every path redirects, even one the site would 404: the new host answers it.
	assert.equal(location('/wp-login.php'), `https://${SITE}/wp-login.php`);
	// The query byte for byte as sent: encoding, repeats, bare names, and the
	// order across names, which request.querystring loses (the model sorts the
	// names, as CloudFront reordered the live probe on 2026-10-25).
	for (const query of ['?a=1&a=2&flag&q=a%20b', '?probe=a%26b%20c&n=1&n=2', '?z=1&a=2&z=3', '?flag=&x=%E2%9C%93', '?']) {
		assert.equal(location(`/share${query}`), `https://${SITE}/share${query}`, query);
	}
	assert.equal(location('/share'), `https://${SITE}/share`);
});

test('the test model of a CloudFront request matches what the live probe showed', () => {
	const r = cfRequest('/page?probe=a%26b%20c&n=1&n=2');
	assert.equal(r.uri, '/page');
	assert.equal(r.rawQueryString(), 'probe=a%26b%20c&n=1&n=2');
	assert.deepEqual(Object.keys(r.querystring), ['n', 'probe']);
	assert.deepEqual(r.querystring.n.multiValue, [{ value: '1' }, { value: '2' }]);
	assert.deepEqual(r.querystring.probe, { value: 'a%26b%20c' });
	assert.equal(cfRequest('/page?').rawQueryString(), '');
	assert.equal(cfRequest('/page').rawQueryString(), undefined);
});

test('a request without a Host header (the e2e site server) is served, not redirected', () => {
	assert.equal(outcome('/projects/abc'), '/index.html');
});

// --- api_strip_prefix ---------------------------------------------------------

test('api_strip_prefix strips /api and overwrites the viewer address', () => {
	const api = loadFunction('api_strip_prefix');
	const e = viewerRequest('/api/auth/login');
	e.request.headers['x-viewer-address'] = { value: '203.0.113.1' }; // forged by the viewer
	const r = api.handler(e);
	assert.equal(r.uri, '/auth/login');
	assert.equal(r.headers['x-viewer-address'].value, '198.51.100.7');
	assert.equal(api.handler(viewerRequest('/api')).uri, '/');
	assert.equal(api.handler(viewerRequest('/api/')).uri, '/');
});

// tiles_range (/tiles/*): the map's public archives only by one bounded byte
// range, so one request can't pull gigabytes (the cost bound, docs/deployment.md
// § Map tiles); glyph ranges and the font licence whole; nothing else.
const tiles = loadFunction('tiles_range', ['MAX_RANGE']);
const tilesRequest = (uri, range, method = 'GET') => ({
	request: { method, uri, querystring: {}, headers: range === undefined ? {} : { range: { value: range } }, cookies: {} },
	viewer: { ip: '198.51.100.7' }
});
const tilesOutcome = (uri, range, method) => {
	const r = tiles.handler(tilesRequest(uri, range, method));
	return 'statusCode' in r ? r.statusCode : 'S3';
};

test('tiles: an archive passes by one closed range up to 2 MiB (the PMTiles header, a directory, a tile)', () => {
	assert.equal(tiles.MAX_RANGE, 2 * 1024 * 1024);
	for (const [uri, range] of [
		['/tiles/south-africa.pmtiles', 'bytes=0-16383'],
		['/tiles/terrain.pmtiles', 'bytes=1048576000-1048627199'],
		['/tiles/terrain.pmtiles', `bytes=0-${2 * 1024 * 1024 - 1}`],
		['/tiles/south-africa.pmtiles', 'bytes=5-5']
	]) {
		assert.equal(tilesOutcome(uri, range), 'S3', `${uri} ${range}`);
	}
	assert.equal(tilesOutcome('/tiles/terrain.pmtiles', undefined, 'HEAD'), 'S3');
});

test('tiles: an archive without a bounded range is refused with 416 before S3 (no whole-file download)', () => {
	for (const range of [undefined, '', 'bytes=0-', 'bytes=-500', `bytes=0-${2 * 1024 * 1024}`, 'bytes=10-5', 'bytes=0-99,200-299', 'items=0-10', 'bytes=0-1e9', 'bytes= 0-10', 'bytes=0-9999999999999999']) {
		assert.equal(tilesOutcome('/tiles/terrain.pmtiles', range), 416, String(range));
	}
	const r = tiles.handler(tilesRequest('/tiles/terrain.pmtiles'));
	assert.equal(r.headers['cache-control'].value, 'no-store');
});

test('tiles: glyph ranges and the font licence pass whole', () => {
	for (const uri of ['/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf', '/tiles/fonts/Noto%20Sans%20Italic/65280-65535.pbf', '/tiles/fonts/Noto%20Sans%20Medium/256-511.pbf', '/tiles/fonts/OFL.txt']) {
		assert.equal(tilesOutcome(uri), 'S3', uri);
	}
});

test('tiles: anything else under /tiles/ is a 404 from the function', () => {
	for (const uri of [
		'/tiles/',
		'/tiles/index.html',
		'/tiles/South-Africa.pmtiles',
		'/tiles/a/b.pmtiles',
		'/tiles/../reference/x.json',
		'/tiles/fonts/Noto%20Sans%20Regular/1-256.pbf',
		'/tiles/fonts/Noto%20Sans%20Regular/65536-65791.pbf',
		'/tiles/fonts/Noto%20Sans%20Regular/0-255.pbf.bak',
		'/tiles/fonts/../../x/0-255.pbf',
		'/tiles/fonts/OFL.txt.zip',
		'/tiles/fonts/a/b/0-255.pbf'
	]) {
		assert.equal(tilesOutcome(uri, 'bytes=0-10'), 404, uri);
	}
	assert.ok(Buffer.byteLength(functionCode('tiles_range')) < 8 * 1024);
});
