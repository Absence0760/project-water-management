import { describe, expect, it } from 'vitest';
import type { CumulativeReport, CumulativeRow } from '@water-management/engine';
import type { AssessorQuestion, Scenario } from '#lib/api/types.js';
import { assessable, assessmentCsv, assessmentState, baselineOf, changeText, changeTone, interactionWords, pickBlocked, rowLabel, valueText } from './cumulative';

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
		// A dam the applications touch: its own name, never "Outlet" or "Catchment".
		expect(rowLabel(row({ metric: 'dam_firm_yield', site: 'Rooikloof', siteNodeId: 'r', isOutlet: false, unit: 'm³/year' }))).toEqual({ measure: 'Firm yield of the dam', site: 'Rooikloof' });
		expect(rowLabel(row({ metric: 'dam_reliability', site: 'Rooikloof', siteNodeId: 'r', isOutlet: false, unit: 'fraction' }))).toEqual({ measure: 'Assurance of supply at the dam', site: 'Rooikloof' });
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
		expect(valueText(250_000, 'm³/year')).toBe('250\u202f000 m³/year');
		expect(changeText(-12_000, 'm³/year')).toBe('−12\u202f000 m³/year');
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

	it('carries the dam rows (evidence-26 assessments) like any other row', () => {
		const dam = row({ metric: 'dam_firm_yield', site: 'Rooikloof', siteNodeId: 'r', isOutlet: false, unit: 'm³/year', higherIsWorse: false, baseline: 365_250 });
		const report: CumulativeReport = { scenarios: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], rows: [dam], warnings: [], dams: { nodeIds: ['r'], onVolumes: false } };
		expect(assessmentCsv(report).split('\r\n')[1]).toBe('Firm yield of the dam,Rooikloof,m³/year,365250,12,13,18,2,3,5,8,3');
	});

	it('with questions, a blank line then each "Ask the assessors why" question and its answer (issue #523 G7)', () => {
		const report: CumulativeReport = { scenarios: [{ id: 'a', name: 'A' }], rows: [row({ singles: [12], singleChanges: [2] })], warnings: [] };
		const q = (over: Partial<AssessorQuestion>): AssessorQuestion => ({
			id: 'q1',
			scenarioId: 'a',
			scenarioName: 'Raise the dam',
			askedAt: '2026-10-01T08:00:00.000Z',
			problem: "op 1 (node.set): doesn't apply to the catchment as modelled",
			opIndexes: [0],
			ops: [],
			rules: ['shares'],
			assessorText: 'op 1 (node.set): flow shares add up to 125 %',
			answer: null,
			answeredAt: null,
			...over
		});
		const lines = assessmentCsv(report, [
			q({ answer: 'The catchment is fully allocated, so the share can’t grow.', answeredAt: '2026-10-02T09:00:00.000Z' }),
			q({ id: 'q2', scenarioName: '=Pump, more', problem: 'line "two"' })
		]).split('\r\n');
		expect(lines[2]).toBe('');
		expect(lines[3]).toBe('Application,Asked,The applicant read,In its own words,Answer,Answered');
		expect(lines[4]).toBe(
			`Raise the dam,2026-10-01T08:00:00.000Z,op 1 (node.set): doesn't apply to the catchment as modelled,op 1 (node.set): flow shares add up to 125 %,"The catchment is fully allocated, so the share can’t grow.",2026-10-02T09:00:00.000Z`
		);
		// User text guarded as the matrix's names are; an unanswered question leaves the answer empty.
		expect(lines[5]).toBe(`"'=Pump, more",2026-10-01T08:00:00.000Z,"line ""two""",op 1 (node.set): flow shares add up to 125 %,,`);
		expect(assessmentCsv(report, [])).toBe(assessmentCsv(report));
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

	it('its job done, its dams’ firm-yield jobs still coming back (297): pending, with how many are back', () => {
		expect(assessmentState({ status: 'pending', job: job('done', null, 100), problems: [], yields: { done: 6, total: 24 } })).toEqual({
			kind: 'pending',
			text: 'Working out the firm yield of each dam the applications touch (6 of 24)…',
			progress: 25
		});
		// Its job still running: the runs first, whatever the yields say.
		expect(assessmentState({ status: 'pending', job: job('running', null, 40), problems: [], yields: null })).toMatchObject({ progress: 40 });
		// A yield job that stopped: the API reads the assessment as failed, naming it.
		expect(assessmentState({ status: 'failed', job: job('done'), problems: ['The baseline: the firm yield of "Upper farm" didn’t finish (boom)'], yields: { done: 3, total: 4 } })).toMatchObject({
			kind: 'stopped',
			lines: ['The baseline: the firm yield of "Upper farm" didn’t finish (boom)']
		});
	});
});

describe('the background at full allocation (295)', () => {
	const baseline: CumulativeReport = { scenarios: [{ id: 'a', name: 'A' }], rows: [row(), row({ metric: 'outlet_flow', site: null, isOutlet: false, unit: 'm³/day', baseline: 1000 })], warnings: [] };
	const bgTable: CumulativeReport = {
		scenarios: [{ id: 'a', name: 'A' }],
		rows: [row({ baseline: 40, singles: [44], combined: 50, singleChanges: [4], sumOfSingles: 4, combinedChange: 10, interaction: 6 })],
		warnings: []
	};
	const background = { label: 'Existing authorised use (full allocation)', run: { id: 'r9', label: 'Full allocation', scenarioName: 'At full allocation', createdAt: '2026-10-30T00:00:00Z' }, report: bgTable };

	it('baselineOf finds the hydrologist’s baseline value of the same measure at the same site', () => {
		expect(baselineOf(baseline, bgTable.rows[0]!)).toBe(10);
		expect(baselineOf(baseline, { metric: 'outlet_flow', siteNodeId: null, isOutlet: false })).toBe(1000);
		expect(baselineOf(baseline, { metric: 'reserve_deficit', siteNodeId: null, isOutlet: true })).toBeNull();
	});

	it('the CSV keeps the baseline’s table as it was, then the background’s own labelled table with the baseline beside it', () => {
		const plain = assessmentCsv(baseline).split('\r\n');
		const lines = assessmentCsv({ ...baseline, background }).split('\r\n');
		expect(lines.slice(0, 3)).toEqual(plain.slice(0, 3));
		expect(lines[3]).toBe('');
		expect(lines[4]).toBe('Existing authorised use (full allocation): Full allocation,A separate comparison: the baseline above stays the hydrologist’s run');
		expect(lines[5]).toBe('Measure,Site,Unit,Baseline,Background (full allocation),A alone,All together,Change: A alone,Sum of changes alone,Change together,Interaction (together − sum)');
		expect(lines[6]).toBe('Days the EWR is not met,Outlet (Outlet gauge),days,10,40,44,50,4,4,10,6');
		expect(lines[7]).toBe('');
	});
});
