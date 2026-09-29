// The e2e site server (site.ts) answers as production's CloudFront does,
// because it routes through the spa_rewrite function itself. Run by
// `pnpm -C e2e test` (node:test).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createSiteServer } from './site.ts';

const dir = mkdtempSync(join(tmpdir(), 'e2e-site-'));
const server = createSiteServer(dir);
let base = '';

before(async () => {
	writeFileSync(join(dir, 'index.html'), 'SPA');
	writeFileSync(join(dir, 'welcome.html'), 'WELCOME');
	writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
	mkdirSync(join(dir, '_app/immutable'), { recursive: true });
	writeFileSync(join(dir, '_app/immutable/start.abc.js'), 'JS');
	// A stray file at the root that no CloudFront location covers.
	writeFileSync(join(dir, 'stray.pdf'), 'PDF');
	await new Promise<void>((ok) => server.listen(0, 'localhost', ok));
	base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server.close();
	rmSync(dir, { recursive: true, force: true });
});

async function get(path: string) {
	const r = await fetch(base + path);
	return { status: r.status, type: r.headers.get('content-type'), body: await r.text() };
}

test('an extension-less SPA route gets index.html', async () => {
	for (const p of ['/', '/projects/abc', '/login', '/help/']) {
		assert.deepEqual(await get(p), { status: 200, type: 'text/html; charset=utf-8', body: 'SPA' }, p);
	}
});

test('a prerendered page is served from its own HTML', async () => {
	assert.equal((await get('/welcome')).body, 'WELCOME');
});

test("the build's files are served as they are", async () => {
	assert.deepEqual(await get('/_app/immutable/start.abc.js'), { status: 200, type: 'text/javascript; charset=utf-8', body: 'JS' });
	assert.deepEqual(await get('/favicon.svg'), { status: 200, type: 'image/svg+xml', body: '<svg/>' });
});

test("a path with an extension outside the build's locations gets CloudFront's 404 page", async () => {
	for (const p of ['/nope.pdf', '/wp-login.php', '/.env', '/projects/abc/export.xlsx', '/stray.pdf']) {
		const r = await get(p);
		assert.equal(r.status, 404, p);
		assert.equal(r.type, 'text/html; charset=utf-8', p);
		assert.match(r.body, /<title>Page not found<\/title>/, p);
	}
});

test('a missing file inside a build location gets a plain 404, as S3 answers', async () => {
	for (const p of ['/_app/immutable/gone.js', '/favicon.ico', '/_app/%E0%A4%A.js']) {
		const r = await get(p);
		assert.equal(r.status, 404, p);
		assert.doesNotMatch(r.body, /SPA/, p);
	}
});
