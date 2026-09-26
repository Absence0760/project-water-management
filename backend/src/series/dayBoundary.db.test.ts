// A series says how its days were built from sub-daily readings
// (033_series_day_boundary.sql, issue #40 (b) amendment 5): set by an upload,
// cleared by a replace that doesn't say, kept by a merge, and a merge of days
// added up in the other window is refused (the same splice rule as 032's
// version guard). Also: the alternative catchment gauge is a series kind.
import { describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const KIND = 'rain_catchment_alt_mm';
async function project(u: User, name: string) {
	return (await u.call('POST', '/projects', { name })).body.project.id as string;
}
const put = (u: User, pid: string, body: Record<string, unknown>) =>
	u.call('PUT', `/projects/${pid}/series`, { kind: KIND, unit: 'mm', startDate: '2012-01-01', values: [1, 2], ...body });
const merge = (u: User, pid: string, body: Record<string, unknown>) =>
	u.call('POST', `/projects/${pid}/series/merge`, { kind: KIND, unit: 'mm', startDate: '2012-01-03', values: [3], ...body });
const boundary = async (u: User, pid: string, name = '') =>
	((await u.call('GET', `/projects/${pid}/series`)).body.series as { kind: string; name: string; dayBoundary: string | null }[]).find(
		(s) => s.kind === KIND && s.name === name
	)?.dayBoundary;

describe('series day boundary', () => {
	it('an upload records its day boundary; a replace that doesn’t say clears it', async () => {
		const u = await signUp('DayPut');
		const pid = await project(u, 'Days');
		expect((await put(u, pid, { dayBoundary: '08:00' })).body).toMatchObject({ kind: KIND, dayBoundary: '08:00' });
		expect(await boundary(u, pid)).toBe('08:00');
		expect((await put(u, pid, {})).body.dayBoundary).toBeNull();
		expect((await put(u, pid, { dayBoundary: '07:00' })).status).toBe(400);
		// The reanalysis kind is a series kind too.
		expect((await put(u, pid, { kind: 'rain_reanalysis_mm' })).status).toBe(200);
	});

	it('a merge keeps it; days of the other window are refused (409); a new or empty series takes the days’ boundary', async () => {
		const u = await signUp('DayMerge');
		const pid = await project(u, 'Days');
		await put(u, pid, { dayBoundary: '08:00' });
		const refused = await merge(u, pid, { dayBoundary: '00:00' });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/^the series holds 08:00–08:00 days and these days are 00:00–00:00 days/);
		expect((await merge(u, pid, { dayBoundary: null })).status).toBe(409);
		// Positive controls: the same window, and days that don't say.
		expect((await merge(u, pid, { dayBoundary: '08:00' })).body.dayBoundary).toBe('08:00');
		expect((await merge(u, pid, { startDate: '2012-01-04', values: [4] })).body.dayBoundary).toBe('08:00');
		expect((await merge(u, pid, { name: 'New', dayBoundary: '00:00' })).body).toMatchObject({ name: 'New', dayBoundary: '00:00' });
		await put(u, pid, { name: 'Blank', values: [null, null] });
		expect((await merge(u, pid, { name: 'Blank', dayBoundary: '08:00' })).body.dayBoundary).toBe('08:00');
	});

	it('a copy and the exported document keep it, and an import stores it', async () => {
		const u = await signUp('DayCopy');
		const pid = await project(u, 'Days source');
		await put(u, pid, { dayBoundary: '08:00' });
		await put(u, pid, { kind: 'rain_catchment_mm', values: [5] });
		const copy = await u.call('POST', `/projects/${pid}/copy`, { name: 'Days copy' });
		expect(copy.status).toBe(201);
		expect(await boundary(u, copy.body.project.id)).toBe('08:00');
		const doc = (await u.call('GET', `/projects/${pid}/export.json`)).body as { series: Record<string, unknown>[] };
		expect(doc.series.find((s) => s.kind === KIND)).toMatchObject({ dayBoundary: '08:00' });
		// Daily values export without the key, as before.
		expect(doc.series.find((s) => s.kind === 'rain_catchment_mm')).not.toHaveProperty('dayBoundary');
		const imported = await u.call('POST', '/projects/import', { ...doc, name: 'Days imported' });
		expect(imported.status).toBe(201);
		expect(await boundary(u, imported.body.project.id)).toBe('08:00');
	});

	it('a revision keeps it, so a restore puts the boundary back with the values', async () => {
		const u = await signUp('DayRestore');
		const pid = await project(u, 'Days restore');
		const first = (await put(u, pid, { dayBoundary: '08:00' })).body as { id: string };
		// Replaced by daily values: the 08:00 series is kept as a revision.
		expect((await put(u, pid, { values: [7, 8] })).body.dayBoundary).toBeNull();
		const revs = (await u.call('GET', `/projects/${pid}/series/${first.id}/revisions`)).body.revisions as { id: string; dayBoundary: string | null }[];
		expect(revs[0]!.dayBoundary).toBe('08:00');
		const restored = await u.call('POST', `/projects/${pid}/series/${first.id}/revisions/${revs[0]!.id}/restore`, {});
		expect(restored.status).toBe(200);
		expect(restored.body).toMatchObject({ dayBoundary: '08:00' });
		// And the daily values it replaced are a revision without one.
		const after = (await u.call('GET', `/projects/${pid}/series/${first.id}/revisions`)).body.revisions as { dayBoundary: string | null }[];
		expect(after[0]!.dayBoundary).toBeNull();
	});
});
