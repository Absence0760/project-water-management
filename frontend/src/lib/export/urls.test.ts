import { describe, expect, it } from 'vitest';
import { exportUrls, fallbackFilename, filenameFromDisposition, runDownloadItems } from './urls';

const P = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const N = '33333333-3333-4333-8333-333333333333';

describe('exportUrls', () => {
	const urls = exportUrls('http://localhost:3001/');

	it('builds the documented endpoint paths', () => {
		expect(urls.runDaily(P, R)).toBe(`http://localhost:3001/projects/${P}/runs/${R}/export/daily.csv`);
		expect(urls.runDaily(P, R, N)).toBe(`http://localhost:3001/projects/${P}/runs/${R}/export/daily.csv?nodeId=${N}`);
		expect(urls.runFarms(P, R, 'runoff')).toBe(`http://localhost:3001/projects/${P}/runs/${R}/export/farms.csv?key=runoff`);
		expect(urls.runFarms(P, R, 'ewr', { from: '2010-01-01' })).toMatch(/farms\.csv\?key=ewr&from=2010-01-01$/);
		expect(urls.runSummary(P, R)).toBe(`http://localhost:3001/projects/${P}/runs/${R}/export/summary.csv`);
		expect(urls.series(P, 'abc')).toBe(`http://localhost:3001/projects/${P}/series/abc/export.csv`);
		expect(urls.project(P)).toBe(`http://localhost:3001/projects/${P}/export.json`);
	});

	it('adds only the window bounds that are set', () => {
		expect(urls.runDaily(P, R, null, { from: '2010-01-01' })).toMatch(/daily\.csv\?from=2010-01-01$/);
		expect(urls.series(P, 's', { from: '2010-01-01', to: '2018-12-31' })).toMatch(/\?from=2010-01-01&to=2018-12-31$/);
	});

	it('works with the production relative base and encodes ids', () => {
		const prod = exportUrls('/api');
		expect(prod.project('a/b')).toBe('/api/projects/a%2Fb/export.json');
	});
});

describe('runDownloadItems', () => {
	it('lists summary, catchment and one entry per node in the given order', () => {
		const items = runDownloadItems(exportUrls('/api'), P, R, [
			{ id: N, name: 'Upper farm' },
			{ id: 'n2', name: 'Gauge' }
		]);
		expect(items.map((i) => i.label)).toEqual([
			'Run summary (CSV)',
			'Daily series — catchment (CSV)',
			'Daily series — Upper farm (CSV)',
			'Daily series — Gauge (CSV)'
		]);
		expect(items[2]!.url).toContain(`nodeId=${N}`);
	});

	it('adds the two all-farms fragmentation tables after the catchment when the run has farms', () => {
		const items = runDownloadItems(exportUrls('/api'), P, R, [{ id: N, name: 'Upper farm' }], true);
		expect(items.map((i) => i.label)).toEqual([
			'Run summary (CSV)',
			'Daily series — catchment (CSV)',
			'Fragmented flow — all farms (CSV)',
			'Fragmented EWR — all farms (CSV)',
			'Daily series — Upper farm (CSV)'
		]);
		expect(items[2]!.url).toBe(`/api/projects/${P}/runs/${R}/export/farms.csv?key=runoff`);
		expect(items[3]!.url).toBe(`/api/projects/${P}/runs/${R}/export/farms.csv?key=ewr`);
	});
});

describe('filenameFromDisposition', () => {
	it('reads quoted, bare and RFC 5987 file names', () => {
		expect(filenameFromDisposition('attachment; filename="a_b_2026-01-01.csv"', 'x')).toBe('a_b_2026-01-01.csv');
		expect(filenameFromDisposition('attachment; filename=plain.csv', 'x')).toBe('plain.csv');
		expect(filenameFromDisposition(`attachment; filename="f.csv"; filename*=UTF-8''m%C2%B3.csv`, 'x')).toBe('m³.csv');
	});

	it('falls back when the header is missing or empty', () => {
		expect(filenameFromDisposition(null, 'daily.csv')).toBe('daily.csv');
		expect(filenameFromDisposition('attachment', 'daily.csv')).toBe('daily.csv');
		expect(fallbackFilename('/api/projects/p/runs/r/export/daily.csv?nodeId=n')).toBe('daily.csv');
		expect(fallbackFilename('')).toBe('download');
	});
});
