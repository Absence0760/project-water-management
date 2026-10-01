import { describe, expect, it } from 'vitest';
import type { CumulativeReport, CumulativeRow } from '@water-management/engine';
import type { Scenario } from '$lib/api/types';
import { assessable, assessmentCsv, assessmentState, changeText, changeTone, interactionWords, pickBlocked, rowLabel, valueText } from './cumulative';

const app = (id: string, status: Scenario['status'], baseRunId = 'r1', name = id): Scenario => ({ id, name, status, baseRunId }) as Scenario;

const row = (over: Partial<CumulativeRow> = {}): CumulativeRow => ({
	metric: 'ewr_days_not_met',
	siteNodeId: null,
	site: 'Outlet gauge',
	isOutlet: true,
	unit: 'days',
	higherIsWorse: true,
	baseline: 10,
	singles: [12, 13],
	combined: 18,
	singleChanges: [2, 3],
	sumOfSingles: 5,
	combinedChange: 8,
	interaction: 3,
	...over
});

describe('assessable and pickBlocked', () => {
	it('offers submitted and decided applications only', () => {
		expect(assessable([app('a', 'submitted'), app('b', 'decided'), app('c', 'withdrawn'), app('d', 'draft')]).map((a) => a.id)).toEqual(['a', 'b']);
	});

	it('blocks one on another base run once one is picked, naming the picked one', () => {
		const items = [app('a', 'submitted', 'r1', 'Raise the dam'), app('b', 'submitted', 'r1'), app('c', 'submitted', 'r2')];
		expect(pickBlocked(items, [], 'c')).toBeNull();
		expect(pickBlocked(items, ['a'], 'b')).toBeNull();
		expect(pickBlocked(items, ['a'], 'c')).toBe('based on another run than “Raise the dam”');
		// Its own tick never blocks it.
		expect(pickBlocked(items, ['c'], 'c')).toBeNull();
	});
});

describe('the matrix cells', () => {
	it('labels a row by measure and site', () => {
		expect(rowLabel(row())).toEqual({ measure: 'Days the EWR is not met', site: 'Outlet (Outlet gauge)' });
		expect(rowLabel(row({ isOutlet: false, site: 'Weir', siteNodeId: 'g' }))).toEqual({ measure: 'Days the EWR is not met', site: 'Weir' });
		expect(rowLabel(row({ metric: 'outlet_flow', site: null, isOutlet: false }))).toEqual({ measure: 'Mean flow at the outlet', site: 'Catchment' });
	});

	it('writes values and signed changes in their unit', () => {
		expect(valueText(12, 'days')).toBe('12');
		expect(valueText(0.953, 'fraction')).toBe('95.3%');
		expect(valueText(null, 'days')).toBe('–');
		expect(valueText(1500, 'm³/day')).toBe('1\u202f500 m³/day');
		expect(changeText(3, 'days')).toBe('+3');
		expect(changeText(-1500, 'm³/day')).toBe('−1\u202f500 m³/day');
		expect(changeText(0, 'months')).toBe('±0');
		expect(changeText(-0.021, 'fraction')).toBe('−2.1 pts');
	});

	it('tones a change by whether a rise is worse', () => {
		expect(changeTone(2, true)).toBe('worse');
		expect(changeTone(-2, true)).toBe('better');
		expect(changeTone(-2, false)).toBe('worse');
		expect(changeTone(1e-12, true)).toBe('none');
		expect(changeTone(null, true)).toBe('none');
	});

	it('says the interaction in plain words', () => {
		expect(interactionWords(row())).toBe('Together they make this 3 worse than their separate changes add up to.');
		expect(interactionWords(row({ interaction: 0 }))).toBe('Together they change this by what their separate changes add up to.');
		expect(interactionWords(row({ metric: 'outlet_flow', unit: 'm³/day', higherIsWorse: false, interaction: 250 }))).toBe(
			'Together they make this 250 m³/day better than their separate changes add up to.'
		);
		expect(interactionWords(row({ interaction: null }))).toMatch(/^Not assessed/);
	});
});

describe('assessmentCsv', () => {
	it('one line per row, raw numbers, names guarded against CSV injection', () => {
		const report: CumulativeReport = { scenarios: [{ id: 'a', name: '=Raise, dam' }, { id: 'b', name: 'More "lucerne"' }], rows: [row(), row({ metric: 'outlet_flow', site: null, isOutlet: false, unit: 'm³/day', baseline: 1000.5, interaction: null })], warnings: [] };
		const lines = assessmentCsv(report).split('\r\n');
		expect(lines[0]).toBe(
			`Measure,Site,Unit,Baseline,"'=Raise, dam alone","More ""lucerne"" alone",All together,"Change: =Raise, dam alone","Change: More ""lucerne"" alone",Sum of changes alone,Change together,Interaction (together − sum)`
		);
		expect(lines[1]).toBe('Days the EWR is not met,Outlet (Outlet gauge),days,10,12,13,18,2,3,5,8,3');
		expect(lines[2]).toBe('Mean flow at the outlet,Catchment,m³/day,1000.5,12,13,18,2,3,5,8,');
		expect(lines[3]).toBe('');
	});
});

describe('assessmentState', () => {
	const job = (status: string, error: string | null = null, progress: number | null = null) => ({ id: 'j', status, error, progress }) as never;
	it('reads the assessment’s status, then its job’s', () => {
		expect(assessmentState({ status: 'complete', job: null, problems: [] })).toEqual({ kind: 'complete' });
		expect(assessmentState({ status: 'refused', job: job('done'), problems: ['x'] })).toEqual({ kind: 'stopped', text: 'These applications no longer combine on their baseline:', lines: ['x'] });
		expect(assessmentState({ status: 'failed', job: job('done'), problems: ['y'] })).toMatchObject({ kind: 'stopped', lines: ['y'] });
		expect(assessmentState({ status: 'pending', job: job('running', null, 40), problems: [] })).toEqual({ kind: 'pending', text: 'Running each application alone and all together…', progress: 40 });
		expect(assessmentState({ status: 'pending', job: job('queued'), problems: [] })).toMatchObject({ kind: 'pending', progress: null });
		expect(assessmentState({ status: 'pending', job: job('dead', 'boom'), problems: [] })).toEqual({ kind: 'stopped', text: 'This assessment could not run: boom', lines: [] });
		expect(assessmentState({ status: 'pending', job: null, problems: [] })).toMatchObject({ kind: 'stopped' });
	});
});
