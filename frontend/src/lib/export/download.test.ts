import { describe, expect, it } from 'vitest';
import { DownloadError, fetchDownload } from './download';

const respond = (body: BodyInit | null, init: ResponseInit) => (async () => new Response(body, init)) as typeof fetch;

describe('fetchDownload', () => {
	it('returns the file with the server-chosen name and sends credentials', async () => {
		let seen: RequestInit | undefined;
		const f = (async (_url: string, init?: RequestInit) => {
			seen = init;
			return new Response('\uFEFFdate,x\r\n', {
				status: 200,
				headers: { 'content-disposition': 'attachment; filename="p_run_daily_2026-01-01.csv"' }
			});
		}) as typeof fetch;
		const { blob, filename } = await fetchDownload('/api/projects/p/runs/r/export/daily.csv', f);
		expect(filename).toBe('p_run_daily_2026-01-01.csv');
		expect(seen?.credentials).toBe('include');
		expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
	});

	it('falls back to the URL file name', async () => {
		const { filename } = await fetchDownload('/api/x/export.json?y=1', respond('{}', { status: 200 }));
		expect(filename).toBe('export.json');
	});

	it('surfaces the server message for 413 and friendly text otherwise', async () => {
		const big = respond(JSON.stringify({ error: 'export larger than 5 MB — narrow it' }), { status: 413 });
		await expect(fetchDownload('/u', big)).rejects.toMatchObject({ status: 413, message: 'export larger than 5 MB — narrow it' });
		await expect(fetchDownload('/u', respond('<html>', { status: 404 }))).rejects.toThrow(/Not found/);
		await expect(fetchDownload('/u', respond(null, { status: 502 }))).rejects.toThrow('Download failed (502)');
	});

	it('carries the server’s error code and params, for the translated pages', async () => {
		const held = respond(JSON.stringify({ error: 'you downloaded your data a moment ago', code: 'export_throttled', params: { seconds: 30 } }), { status: 429 });
		await expect(fetchDownload('/u', held)).rejects.toMatchObject({ status: 429, code: 'export_throttled', params: { seconds: 30 } });
		await expect(fetchDownload('/u', respond(null, { status: 502 }))).rejects.toMatchObject({ code: null, params: {} });
	});

	it('reports network failures', async () => {
		const down = (async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch;
		const err = await fetchDownload('/u', down).catch((e) => e);
		expect(err).toBeInstanceOf(DownloadError);
		expect(err.status).toBe(0);
	});
});
