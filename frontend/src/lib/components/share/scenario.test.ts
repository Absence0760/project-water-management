// The scenario link's words (WP-3.15, ./scenario.ts): the EWR per site
// first, the baseline beside the application; a baseline assumption named as
// one; volumes only when the API sends them; the link's kind from the fragment.
import { describe, expect, it } from 'vitest';
import type { NetworkNode, ScenarioOp } from '@water-management/engine';
import type { SharedRun, ShareScenario } from '$lib/api/types';
import { changeRows, daysLine, ewrRows, readShareKind, resultsNote, statusLine, volumeRows } from './scenario';

const sp = (s: string | null | undefined) => s?.replace(/[\u00a0\u202f]/g, ' ');
const OWN = 'n-own';

const run = (met: number, over: Partial<SharedRun> = {}): SharedRun => ({
	engineVersion: '1.31.0',
	startDate: '2020-10-01',
	endDate: '2021-09-30',
	createdAt: '2026-09-29T10:00:00Z',
	ewrDaysNotMet: 12 - met,
	ewrFractionDaysNotMet: 0.1,
	volumes: { meanNaturalFlowM3Day: 5000, meanSimulatedOutflowM3Day: 4000 + met, farms: { count: 5, demandM3Day: 900, suppliedM3Day: 800, belowTarget: 1 } },
	ewrSites: [
		{ name: null, isOutlet: true, months: 12, met, rate: met / 12, longestNotMetRun: 1, deficitM3: 10, byMonth: [] },
		{ name: 'Sandspruit weir', isOutlet: false, months: 12, met: 12, rate: 1, longestNotMetRun: 0, deficitM3: 0, byMonth: [] }
	],
	...over
});

const scenario = (over: Partial<ShareScenario['scenario']> = {}): ShareScenario['scenario'] => ({
	id: 's',
	name: 'Raise the dam',
	description: '',
	origin: 'applicant',
	status: 'submitted',
	submittedAt: '2026-09-28T10:00:00Z',
	decidedAt: null,
	outcome: null,
	decisionNote: '',
	ops: [
		{ op: 'node.set', nodeId: OWN, field: 'damCapacityM3', value: 120000 },
		{ op: 'node.set', nodeId: 'n-other', field: 'damCapacityM3', value: 1 }
	],
	opsSha256: 'a'.repeat(64),
	ownedNodeIds: [OWN],
	opNames: [{ id: OWN, name: 'Rooikloof' }],
	classified: null,
	...over
});

describe('readShareKind', () => {
	it('reads a scenario link from the fragment; anything else is the catchment view', () => {
		expect(readShareKind('#t=abc&k=scenario')).toBe('scenario');
		expect(readShareKind('#t=abc')).toBeNull();
		expect(readShareKind('#t=abc&k=pack')).toBeNull();
	});
});

describe('ewrRows', () => {
	it('puts the baseline beside the application at each site, the outlet unnamed, and says which got worse', () => {
		const rows = ewrRows(run(11), run(9));
		expect(rows.map((r) => r.place)).toEqual(['At the catchment outlet', 'At Sandspruit weir']);
		expect(sp(rows[0]!.base)).toBe('Met in 11 of 12 months (92 %)');
		expect(sp(rows[0]!.withApp)).toBe('Met in 9 of 12 months (75 %)');
		expect(rows[0]!.trend).toBe('worse');
		expect(sp(rows[0]!.change)).toBe('2 months more below the Reserve with this application.');
		expect(rows[1]).toMatchObject({ trend: 'same', change: 'No change in the months the Reserve is met.' });
		expect(ewrRows(run(9), run(10))[0]!.trend).toBe('better');
	});

	it('says a site the application has no result for is not assessed', () => {
		const rows = ewrRows(run(11), run(9, { ewrSites: [] }));
		expect(rows[0]!.withApp).toBe('Not assessed');
	});

	it('words the days below the EWR at the outlet', () => {
		expect(daysLine(run(11), run(9))).toBe('Days below the EWR at the outlet: 1 on the baseline, 3 with this application.');
	});
});

describe('changeRows', () => {
	it('names only the applicant’s own unit, and calls a change to another unit a baseline assumption', () => {
		const rows = changeRows(scenario());
		expect(rows.map((r) => r.cls)).toEqual(['proposal', 'baseline']);
		expect(rows[0]!.text).toBe('Rooikloof: damCapacityM3 set to 120000');
		expect(rows[1]!.text).toBe('another hydrological unit: damCapacityM3 set to 1');
		expect(rows[1]!.label).toBe('Baseline assumption');
	});

	it('words the later ops (engine ≥ 1.35.0), naming only the applicant’s own unit', () => {
		const ops: ScenarioOp[] = [
			{ op: 'node.move', nodeId: OWN, downstreamNodeId: 'n-other' },
			{ op: 'node.insert', node: { id: 'n-new', name: 'New weir', kind: 'gauge', downstreamNodeId: OWN } as NetworkNode, upstreamNodeIds: ['n-other'] },
			{ op: 'crop.set', cropId: 'c', field: 'cropFactor', value: new Array(12).fill(0.5) },
			{ op: 'crop.remove', cropId: 'c' },
			{ op: 'landCover.set', patchId: 'p', field: 'densityPct', value: 0 },
			{ op: 'ewrRule.remove', siteNodeId: null },
			{ op: 'allocation.set', allocation: { id: 'a', nodeId: OWN, waterSource: 'surface', volumeM3PerYear: 200000 } },
			{ op: 'allocation.remove', allocationId: 'a' }
		];
		expect(changeRows(scenario({ ops, classified: null })).map((r) => sp(r.text))).toEqual([
			'Rooikloof moved to drain into another hydrological unit',
			'A new hydrological unit or site, “New weir”, placed on the river above Rooikloof',
			'A crop changed: cropFactor',
			'A crop removed',
			'Land cover changed: densityPct',
			'The Reserve’s rule table removed at the catchment outlet',
			'A registered volume set on Rooikloof',
			'A registered volume removed'
		]);
	});

	it('takes the class its run applied when it has one for every op', () => {
		expect(changeRows(scenario({ classified: ['baseline', 'baseline'] })).map((r) => r.cls)).toEqual(['baseline', 'baseline']);
		// A list that doesn't line up with the ops is ignored.
		expect(changeRows(scenario({ classified: ['baseline'] })).map((r) => r.cls)).toEqual(['proposal', 'baseline']);
	});
});

describe('volumeRows, statusLine, resultsNote', () => {
	it('shows the totals only when both runs carry them (the k rule)', () => {
		expect(volumeRows(run(11), run(9))).toHaveLength(3);
		expect(volumeRows(run(11, { volumes: null }), run(9))).toEqual([]);
	});

	it('says where the application stands', () => {
		expect(statusLine(scenario())).toMatch(/^Submitted on .*, awaiting a decision\.$/);
		expect(statusLine(scenario({ status: 'decided', outcome: 'refused', decidedAt: '2026-10-01T10:00:00Z' }))).toMatch(/^Refused on /);
	});

	it('explains missing results', () => {
		expect(resultsNote('ready')).toBeNull();
		expect(resultsNote('none')).toMatch(/not been run/);
		expect(resultsNote('unverified')).toMatch(/weren’t stored by the model run itself/);
	});
});
