// The pure parts of server-side reports: object keys and download names,
// the status a viewer sees, PDF page counting and the render settings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confinementArgs, countPdfPages, DEFAULT_RENDER_TIMEOUT_MS, renderOptionsFromEnv, reportQuery } from './render.js';
import { reportFileName, reportKey, storageKind } from './storage.js';
import { RENDER_ANSWER_WITHIN_MS, reportState } from './store.js';

afterEach(() => vi.unstubAllEnvs());

const P = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';

describe('reportKey', () => {
	it('derives the key from the ids, and refuses anything that is not a UUID (no path games)', () => {
		expect(reportKey(P, R)).toBe(`reports/${P}/${R}.pdf`);
		expect(reportKey(P.toUpperCase(), R)).toBe(`reports/${P}/${R}.pdf`);
		expect(() => reportKey('../other', R)).toThrow('UUIDs');
		expect(() => reportKey(P, `${R}/../x`)).toThrow('UUIDs');
	});
});

describe('reportFileName', () => {
	it('is a safe slug of the project name and the date', () => {
		expect(reportFileName('Upper Kleinberg — 2026 “draft”', '2026-09-25')).toBe('upper-kleinberg-2026-draft-report-2026-09-25.pdf');
		expect(reportFileName('Crème brûlée', '2026-09-25')).toBe('creme-brulee-report-2026-09-25.pdf');
		// Nothing that could break out of the Content-Disposition header.
		expect(reportFileName('a"; filename="evil.exe', '2026-09-25')).toBe('a-filenameevilexe-report-2026-09-25.pdf');
		expect(reportFileName('???', '2026-09-25')).toBe('catchment-report-2026-09-25.pdf');
		expect(reportFileName('x'.repeat(200), '2026-09-25').length).toBeLessThan(90);
	});
});

describe('storageKind', () => {
	it('defaults to local (MinIO), knows s3, and refuses anything else', () => {
		expect(storageKind(undefined)).toBe('local');
		expect(storageKind(' ')).toBe('local');
		expect(storageKind('s3')).toBe('s3');
		expect(() => storageKind('gcs')).toThrow('unknown STORAGE "gcs"');
	});
});

describe('reportState', () => {
	const created = new Date('2026-09-25T10:00:00Z');
	const soon = new Date(created.getTime() + 60_000);
	it('is the report’s own status once finished', () => {
		expect(reportState('done', 'done', created, soon)).toBe('done');
		expect(reportState('failed', 'done', created, soon)).toBe('failed');
	});
	it('follows the job while the render is in hand', () => {
		expect(reportState('queued', 'queued', created, soon)).toBe('queued');
		expect(reportState('queued', 'running', created, soon)).toBe('rendering');
		expect(reportState('queued', 'failed', created, soon)).toBe('retrying');
		expect(reportState('queued', 'dead', created, soon)).toBe('failed');
		// Purged job, unfinished report: it will never finish.
		expect(reportState('queued', null, created, soon)).toBe('failed');
	});
	it('waits for the renderer Lambda, but not for ever', () => {
		expect(reportState('rendering', 'done', created, soon)).toBe('rendering');
		expect(reportState('rendering', 'done', created, new Date(created.getTime() + RENDER_ANSWER_WITHIN_MS + 1))).toBe('failed');
	});
});

describe('reportQuery', () => {
	it('opens the run’s report, or its impact report against the baseline, as the report route reads them', () => {
		expect(reportQuery({ runId: R })).toBe(`run=${R}`);
		const q = new URLSearchParams(reportQuery({ runId: R, against: { projectId: P, runId: '33333333-3333-4333-8333-333333333333' } }));
		expect([...q]).toEqual([
			['run', R],
			['against', `${P}:33333333-3333-4333-8333-333333333333`]
		]);
	});
});

describe('countPdfPages', () => {
	it('counts page objects, not the page tree', () => {
		const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] >>\n2 0 obj << /Type /Page >>\n3 0 obj <</Type/Page/Parent 1 0 R>>\n', 'latin1');
		expect(countPdfPages(pdf)).toBe(2);
		expect(countPdfPages(Buffer.from('not a pdf'))).toBe(0);
	});
});

describe('renderOptionsFromEnv', () => {
	it('defaults to the local dev site and API', () => {
		expect(renderOptionsFromEnv({})).toEqual({ siteUrl: 'http://localhost:7777', apiUrl: 'http://localhost:3001', timeoutMs: DEFAULT_RENDER_TIMEOUT_MS, executablePath: undefined });
	});
	it('takes the render URLs (SITE_URL as the fallback site), a sane timeout, and a Chromium path', () => {
		expect(
			renderOptionsFromEnv({ SITE_URL: 'https://water.example.com/', RENDER_API_URL: 'https://water.example.com/api/', REPORT_RENDER_TIMEOUT_MS: '60000', CHROMIUM_PATH: '/opt/chromium' })
		).toEqual({ siteUrl: 'https://water.example.com', apiUrl: 'https://water.example.com/api', timeoutMs: 60_000, executablePath: '/opt/chromium' });
		expect(renderOptionsFromEnv({ RENDER_SITE_URL: 'http://127.0.0.1:7801', SITE_URL: 'http://x' }).siteUrl).toBe('http://127.0.0.1:7801');
		for (const bad of ['0', '100', '9999999', 'soon']) expect(renderOptionsFromEnv({ REPORT_RENDER_TIMEOUT_MS: bad }).timeoutMs).toBe(DEFAULT_RENDER_TIMEOUT_MS);
	});
});

// The browser-level half of the renderer's confinement (render.origin.db.test.ts
// checks it with real Chromium; the resolver rule is pinned here, since the
// dead proxy alone already stops every HTTP request that test can count).
describe('confinementArgs', () => {
	it('production: one host resolves, one origin goes direct, the rest to a proxy that cannot exist, no WebRTC UDP', () => {
		expect(confinementArgs({ siteUrl: 'https://water.example.com', apiUrl: 'https://water.example.com/api' })).toEqual([
			'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE water.example.com',
			'--proxy-server=http://egress-refused.invalid:9',
			'--proxy-bypass-list=<-loopback>;https://water.example.com',
			'--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
		]);
	});
	it('local: the site and API origins, ports included', () => {
		const args = confinementArgs({ siteUrl: 'http://localhost:7777', apiUrl: 'http://127.0.0.1:3001' });
		expect(args[0]).toBe('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
		expect(args[2]).toBe('--proxy-bypass-list=<-loopback>;http://localhost:7777;http://127.0.0.1:3001');
	});
});
