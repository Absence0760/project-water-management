// The report's browser runs in the project's time zone (issue #521). The
// report pages format stamps in the browser's own zone (frontend
// lib/format/number.ts fmtDate: a run made, a sign-off, a registration check,
// a pack issued, "prepared"), so a renderer pinned to UTC printed a stamp
// between midnight and 02:00 in South Africa on the previous day, while the
// same page printed from a browser there showed the right one. render.ts now
// takes the zone from the render session's answer (renderTimeZone).
//
// Two local servers: the stub site, whose page reports the zone its browser
// runs in and the day it formats a near-midnight stamp on, and the stub API
// (the render-session exchange, which answers with a zone and sets the
// session cookie, and a probe that records what the page reports and whether
// the cookie came with it: the session survives the move to the report's
// context).
//
// Runs the real renderReportPdf with the Chromium from `pnpm test:e2e:install`;
// in the db project for the reason render.origin.db.test.ts gives (CI's
// db-test job installs that Chromium). Locally it skips without it; under CI
// a missing browser fails the file.
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderReportPdf, type RenderOptions } from './render.js';

const chromiumPath = await import('playwright-core').then(({ chromium }) => chromium.executablePath()).catch(() => '');
const haveChromium = !!chromiumPath && existsSync(chromiumPath);
if (!haveChromium && process.env.CI) {
	throw new Error(`render.timezone.db.test.ts: no Playwright Chromium at ${chromiumPath || '(none)'} under CI; the job must install it (.github/workflows/ci.yml db-test)`);
}
if (!haveChromium) console.warn('render.timezone.db.test.ts skipped: no Playwright Chromium (pnpm test:e2e:install)');

/** 00:30 on 1 Oct 2026 in South Africa: 22:30 on 30 Sep in UTC. */
const NEAR_MIDNIGHT = '2026-09-30T22:30:00.000Z';
/** What the render session answers with: a JSON body, or none (204, an API older than the zone). */
let sessionBody: unknown = null;
let probe: { tz: string; day: string; cookie: string } | null = null;
const servers: Server[] = [];
const urls = { site: '', api: '' };

async function listen(name: keyof typeof urls, handler: (req: IncomingMessage, res: ServerResponse) => void) {
	const s = createServer(handler);
	await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
	servers.push(s);
	urls[name] = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
	if (!haveChromium) return;
	await listen('site', (_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		// The day as fmtDate formats it: the browser's own calendar fields.
		res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stub</title></head><body>
			<main class="page report"><h1>Report</h1></main>
			<script>
			(async () => {
				const d = new Date(${JSON.stringify(NEAR_MIDNIGHT)});
				const pad = (x) => String(x).padStart(2, '0');
				const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
				const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
				await fetch(${JSON.stringify(urls.api)} + '/probe?' + new URLSearchParams({ tz, day }), { credentials: 'include' });
				document.querySelector('main').setAttribute('data-report-ready', 'true');
			})();
			</script></body></html>`);
	});
	await listen('api', (req, res) => {
		const cors = { 'access-control-allow-origin': urls.site, 'access-control-allow-credentials': 'true' };
		const url = new URL(req.url ?? '/', urls.api);
		if (req.method === 'POST' && url.pathname === '/auth/render-session') {
			const cookie = { 'set-cookie': 'wm_session=stub-session; Path=/; HttpOnly; SameSite=Lax' };
			if (sessionBody === null) res.writeHead(204, { ...cors, ...cookie }).end();
			else res.writeHead(200, { ...cors, ...cookie, 'content-type': 'application/json' }).end(JSON.stringify(sessionBody));
			return;
		}
		if (url.pathname === '/probe') {
			probe = { tz: url.searchParams.get('tz') ?? '', day: url.searchParams.get('day') ?? '', cookie: req.headers.cookie ?? '' };
			res.writeHead(204, cors).end();
			return;
		}
		res.writeHead(404, cors).end();
	});
});

afterAll(async () => {
	await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

beforeEach(() => {
	probe = null;
	sessionBody = null;
});

const target = { projectId: '00000000-0000-4000-8000-000000000002', runId: '00000000-0000-4000-8000-000000000003', token: 'A'.repeat(43) };
const options = (): RenderOptions => ({ siteUrl: urls.site, apiUrl: urls.api, timeoutMs: 20_000 });

describe.skipIf(!haveChromium)('the report prints in the project’s time zone', () => {
	it('a stamp just after midnight in South Africa prints on South Africa’s day, not UTC’s previous one, with the session kept', async () => {
		sessionBody = { ok: true, timeZone: 'Africa/Johannesburg' };
		const pdf = await renderReportPdf(target, options());
		expect(pdf.pages).toBeGreaterThan(0);
		expect(probe).toEqual({ tz: 'Africa/Johannesburg', day: '2026-10-01', cookie: 'wm_session=stub-session' });
	});

	it('takes the zone the session answers with, not a fixed one (positive control: a zone far from the default)', async () => {
		sessionBody = { ok: true, timeZone: 'Pacific/Pago_Pago' };
		await renderReportPdf(target, options());
		// UTC-11: 11:30 on 30 Sep.
		expect(probe).toEqual({ tz: 'Pacific/Pago_Pago', day: '2026-09-30', cookie: 'wm_session=stub-session' });
	});

	it('prints in the default zone when the answer has none (an older API) or names one Intl does not know', async () => {
		for (const body of [null, { ok: true }, { ok: true, timeZone: null }, { ok: true, timeZone: 'Not/AZone' }]) {
			sessionBody = body;
			probe = null;
			await renderReportPdf(target, options());
			expect(probe, JSON.stringify(body)).toEqual({ tz: 'Africa/Johannesburg', day: '2026-10-01', cookie: 'wm_session=stub-session' });
		}
	});
});
