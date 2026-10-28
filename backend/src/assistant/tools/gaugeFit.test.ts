// get_gauge_fit's statistics (issue #610) are the engine's calibrationStats
// on the gauge's outflow and its record in m³/s, as the run scores its own site.
import { calibrationStats } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { gaugeFitStats, gaugeFitTool } from './gaugeFit.js';
import type { ToolContext } from '../types.js';

describe('gaugeFitStats', () => {
	const days = 400;
	const outflow = Array.from({ length: days }, (_, i) => 86_400 * (1 + Math.sin(i / 20)) + 5_000);
	// The record a run stores: m³/day, NaN on a day without a reading.
	const record = outflow.map((q, i) => (i % 7 === 3 ? Number.NaN : q * (0.9 + 0.2 * Math.cos(i / 11))));

	it('equals calibrationStats on the same arrays, the record in m³/s with no reading as null', () => {
		const window = { startDate: '2020-10-01', windowStart: '2020-11-01', windowEnd: '2021-09-30', exclusions: [{ start: '2021-01-01', end: '2021-01-31', reason: 'weir rebuilt' }] };
		const got = gaugeFitStats(outflow, record, window);
		const want = calibrationStats(
			outflow,
			record.map((v) => (Number.isNaN(v) ? null : v / 86_400)),
			window
		);
		expect(got).toEqual(want);
		expect(got.days).toBeGreaterThan(200);
		expect(got.nse).not.toBeNull();
		expect(got.kge).not.toBeNull();
	});

	it('a gauge without a reading has no scores', () => {
		const s = gaugeFitStats(outflow, outflow.map(() => Number.NaN), { startDate: '2020-10-01' });
		expect([s.days, s.nse]).toEqual([0, null]);
	});
});

describe('get_gauge_fit arguments', () => {
	const ctx = { db: { query: () => Promise.reject(new Error('no database in a unit test')) } } as unknown as ToolContext;
	it('needs a node', async () => {
		expect(await gaugeFitTool.run(ctx, {})).toMatchObject({ ok: false, error: expect.stringMatching(/^invalid arguments: node/) });
	});
});
