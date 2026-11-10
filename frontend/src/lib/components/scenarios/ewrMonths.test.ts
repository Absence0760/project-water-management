import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { judgedBy, rightChoices, rightRun } from './ewrMonths';

const run = (id: string, createdAt: string) => ({ id, createdAt });
const months = { months: 12, met: 9, rate: 0.75 } as unknown as RunSummary['ewrDailyMonths'];
const judged = (method: 'pragmatic' | 'tab' | null, withMonths = true) =>
	({ catchment: { outletEwr: method ? { method } : null }, ewrDailyMonths: withMonths ? months : undefined }) as unknown as Pick<RunSummary, 'catchment' | 'ewrDailyMonths'>;

describe('rightChoices / rightRun: the run on the right', () => {
	const runs = [run('base', '2026-11-01T08:00:00Z'), run('old', '2026-10-01T08:00:00Z'), run('scen', '2026-11-09T18:31:00Z')];

	it('lists every run but the base, newest first', () => {
		expect(rightChoices(runs, 'base').map((r) => r.id)).toEqual(['scen', 'old']);
	});

	it('shows the pick, else the scenario’s latest run, else the newest', () => {
		const choices = rightChoices(runs, 'base');
		expect(rightRun(choices, null, 'scen')).toBe('scen');
		expect(rightRun(choices, 'old', 'scen')).toBe('old');
		expect(rightRun(choices, 'gone', 'scen')).toBe('scen');
		expect(rightRun(choices, 'base', 'missing')).toBe('scen');
		expect(rightRun([], null, 'scen')).toBeNull();
	});
});

describe('judgedBy: which daily EWR the two sides are judged by', () => {
	it('names the one both use', () => {
		expect(judgedBy(judged('pragmatic'), judged(null))).toEqual({ same: true, name: 'the pragmatic EWR' });
	});

	it('says so when the two runs judged different daily EWRs', () => {
		const r = judgedBy(judged('pragmatic'), judged('tab'));
		expect(r).toEqual({ same: false, text: expect.stringContaining('the base by the pragmatic EWR, the other run by the daily EWR from the DRM TAB file') });
	});

	it('leaves out a side made before engine 1.116.0 (it says so itself), and is null when neither has months', () => {
		expect(judgedBy(judged('tab', false), judged('pragmatic'))).toEqual({ same: true, name: 'the pragmatic EWR' });
		expect(judgedBy(judged('tab', false), judged('pragmatic', false))).toBeNull();
		expect(judgedBy(null, null)).toBeNull();
	});
});
