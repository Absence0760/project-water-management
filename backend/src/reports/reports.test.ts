// The pure parts of server-side reports: object keys and download names,
// the status a viewer sees, PDF page counting and the render settings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confinementArgs, countPdfPages, DEFAULT_RENDER_TIMEOUT_MS, RenderError, renderOptionsFromEnv, reportQuery, sessionRefusal, targetPath } from './render.js';
import { packFileName, packPdfKey, packsBucket, reportFileName, reportKey, storageKind } from './storage.js';
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

describe('packPdfKey (116_pack_render)', () => {
	const K = '33333333-3333-4333-8333-333333333333';
	const SHA = '0123456789abcdef'.repeat(4);
	it('is content-addressed under the ids, as app_record_pack_pdf derives it, and refuses anything else', () => {
		expect(packPdfKey(P, K, SHA)).toBe(`packs/${P}/${K}/${SHA}.pdf`);
		expect(packPdfKey(P.toUpperCase(), K.toUpperCase(), SHA)).toBe(`packs/${P}/${K}/${SHA}.pdf`);
		expect(() => packPdfKey('../other', K, SHA)).toThrow('UUIDs');
		expect(() => packPdfKey(P, `${K}/..`, SHA)).toThrow('UUIDs');
		expect(() => packPdfKey(P, K, SHA.toUpperCase())).toThrow('SHA-256');
		expect(() => packPdfKey(P, K, `${SHA.slice(2)}/x`)).toThrow('SHA-256');
	});
});

describe('packFileName', () => {
	it('is a safe slug of the project name, the version and the short code', () => {
		expect(packFileName('Upper Kleinberg — 2026', 3, 'ab12-cd34-ef56')).toBe('upper-kleinberg-2026-evidence-pack-v3-ab12-cd34-ef56.pdf');
		expect(packFileName('a"; filename="evil.exe', 1, 'ab12-cd34-ef56"; x')).toBe('a-filenameevilexe-evidence-pack-v1-ab12-cd34-ef56.pdf');
		expect(packFileName('???', 1, 'ab12-cd34-ef56')).toBe('catchment-evidence-pack-v1-ab12-cd34-ef56.pdf');
	});
});

describe('packsBucket', () => {
	it('is its own bucket: water-packs locally, PACKS_BUCKET when set', () => {
		expect(packsBucket()).toBe(process.env.PACKS_BUCKET?.trim() || 'water-packs');
		vi.stubEnv('PACKS_BUCKET', ' water-management-packs-000000000000 ');
		expect(packsBucket()).toBe('water-management-packs-000000000000');
	});
});

describe('targetPath', () => {
	it('prints a run’s report route, or an issued pack’s own page (and nothing else)', () => {
		const K = '33333333-3333-4333-8333-333333333333';
		expect(targetPath({ projectId: P, runId: R })).toBe(`/projects/${P}/report?run=${R}`);
		expect(targetPath({ projectId: P, packId: K })).toBe(`/projects/${P}/packs/${K}`);
		expect(targetPath({ projectId: P, packId: '../../admin' })).toBe(`/projects/${P}/packs/..%2F..%2Fadmin`);
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

// In production the render-session request goes through CloudFront and the
// WAF (infra/waf.tf), whose rate rules answer a plain 403 with an HTML body.
// Only the API's own coded refusal is final; everything else is retried.
describe('sessionRefusal', () => {
	const refused = { error: 'this render token is invalid, used or expired', code: 'render_token_refused' };

	it('is final for the API’s coded refusal: a used or expired token (400) or a requester who lost access (403)', () => {
		for (const status of [400, 403]) {
			const e = sessionRefusal(status, status === 403 ? { error: 'the requester can no longer see this report', code: 'render_token_refused' } : refused);
			expect(e).toBeInstanceOf(RenderError);
			expect(e).toMatchObject({ retry: false, message: 'the render token was refused (used, expired, or the requester lost access)' });
		}
	});

	it('retries a WAF or CloudFront block: a 403 without the API’s code (an HTML body parses to nothing)', () => {
		expect(sessionRefusal(403, null)).toMatchObject({ retry: true, message: 'the render session could not start (HTTP 403)' });
		expect(sessionRefusal(403, { message: 'Forbidden' })).toMatchObject({ retry: true });
		expect(sessionRefusal(403, { error: 'forbidden' })).toMatchObject({ retry: true });
	});

	it('retries a rate limit, a server error, and any other code (the code must be the render one)', () => {
		expect(sessionRefusal(429, null)).toMatchObject({ retry: true, message: 'the render session could not start (HTTP 429)' });
		expect(sessionRefusal(502, null)).toMatchObject({ retry: true });
		expect(sessionRefusal(500, { error: 'Internal server error' })).toMatchObject({ retry: true });
		expect(sessionRefusal(403, { code: 'not_signed_in' })).toMatchObject({ retry: true });
		expect(sessionRefusal(400, { error: 'invalid request' })).toMatchObject({ retry: true });
	});

	it('retries the code on a status the API never sends it with (a proxy echoing a body is not the API)', () => {
		expect(sessionRefusal(502, refused)).toMatchObject({ retry: true });
		expect(sessionRefusal(429, refused)).toMatchObject({ retry: true });
	});

	it('ignores a body that isn’t an object', () => {
		expect(sessionRefusal(403, 'render_token_refused')).toMatchObject({ retry: true });
		expect(sessionRefusal(400, ['render_token_refused'])).toMatchObject({ retry: true });
	});
});
