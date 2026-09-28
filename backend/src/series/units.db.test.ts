// A series is stored in its kind's canonical unit (m³/s, mm): the model reads
// every flow as m³/s whatever its label says, so a flow given in l/s used to
// run 1 000 × too large. Every route that writes a series converts on the way
// in and refuses a unit it doesn't know (engine units.ts).
import { describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

async function project(u: User, name: string) {
	return (await u.call('POST', '/projects', { name })).body.project.id as string;
}

const stored = async (u: User, projectId: string, kind: string) => {
	const list = (await u.call('GET', `/projects/${projectId}/series`)).body.series as { id: string; kind: string; unit: string }[];
	const s = list.find((x) => x.kind === kind)!;
	return { unit: s.unit, values: (await u.call('GET', `/projects/${projectId}/series/${s.id}`)).body.values as (number | null)[] };
};

describe('series units', () => {
	it('stores a flow given in l/s as m³/s, and merges ML/day into it on the same scale', async () => {
		const u = await signUp('Units');
		const p = await project(u, 'Units');
		const put = await u.call('PUT', `/projects/${p}/series`, { kind: 'flow_observed_m3s', unit: 'l/s', startDate: '2020-01-01', values: [1500, null, 250] });
		expect(put.status).toBe(200);
		expect(put.body.unit).toBe('m³/s');
		expect(await stored(u, p, 'flow_observed_m3s')).toEqual({ unit: 'm³/s', values: [1.5, null, 0.25] });
		// 86.4 ML/day = 1 m³/s, appended as the next day.
		expect((await u.call('POST', `/projects/${p}/series/merge`, { kind: 'flow_observed_m3s', unit: 'ML/day', startDate: '2020-01-04', values: [86.4] })).status).toBe(200);
		const after = await stored(u, p, 'flow_observed_m3s');
		expect(after.values.slice(0, 3)).toEqual([1.5, null, 0.25]);
		expect(after.values[3]).toBeCloseTo(1, 12);
		// Positive control: the canonical unit is stored as given.
		await u.call('PUT', `/projects/${p}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: [3, 0] });
		expect(await stored(u, p, 'rain_catchment_mm')).toEqual({ unit: 'mm', values: [3, 0] });
	});

	it('refuses a unit it does not know, or of the wrong kind, with the accepted ones and no database text', async () => {
		const u = await signUp('Badunits');
		const p = await project(u, 'Bad units');
		for (const [kind, unit] of [['flow_observed_m3s', 'mm'], ['rain_catchment_mm', 'm³/s'], ['flow_logger_m3s', 'gallons']]) {
			const res = await u.call('PUT', `/projects/${p}/series`, { kind, unit, startDate: '2020-01-01', values: [1] });
			expect(res.status, `${kind} ${unit}`).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(/isn't one this series can be given in; use one of/);
		}
		expect((await u.call('GET', `/projects/${p}/series`)).body.series).toEqual([]);
	});

	it('converts series in an imported project document the same way', async () => {
		const u = await signUp('Unitimport');
		const doc = {
			name: 'Imported in l/s',
			model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
			series: [{ kind: 'flow_observed_m3s', name: '', unit: 'L/s', startDate: '2020-01-01', values: [2000] }]
		};
		const res = await u.call('POST', '/projects/import', doc);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(await stored(u, res.body.project.id, 'flow_observed_m3s')).toEqual({ unit: 'm³/s', values: [2] });
	});
});
