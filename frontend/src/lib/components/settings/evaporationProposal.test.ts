// Settings → "Evaporation from the map" (issue #326 B-evap): which state the
// panel shows, the saved row a proposal would replace (the monthly PE row for
// reference ET, the A-pan row for A-pan), whether it holds the proposal
// already, the implied pan coefficient cross-check, and the provenance line.
import { describe, expect, it } from 'vitest';
import type { EvaporationAccepted, EvaporationProposals } from '$lib/api';
import { acceptedText, coverageText, impliedPanCoefficient, outsidePanRange, proposalState, sameAsSaved, savedRow } from './evaporationProposal';

const BASE = [120, 150, 175, 180, 150, 130, 90, 65, 50, 55, 75, 95];
const dataset = {
	dataset: 'synthetic',
	kind: 'et0' as const,
	source: 'SYNTHETIC',
	version: 'synthetic 1',
	method: 'm',
	attribution: 'a',
	firstYear: 1991,
	lastYear: 2020,
	cellDeg: 0.1,
	originLon: 0.05,
	originLat: 0.05,
	loadedAt: '2026-10-02T00:00:00Z',
	synthetic: true
};
const props = (patch: Partial<EvaporationProposals> = {}): EvaporationProposals => ({
	dataset,
	datasets: [{ dataset: 'synthetic', kind: 'et0', version: 'synthetic 1', synthetic: true }],
	boundary: { featureId: 'f', name: 'Catchment' },
	target: 'pe',
	proposal: { monthlyMm: BASE, annualMm: 1335, coverage: 1, cells: 4 },
	settings: { apanMm: Array(12).fill(0), peKind: 'pan', peMm: null },
	accepted: [],
	...patch
});

describe('proposalState', () => {
	it('says why there is nothing to use: no dataset, no boundary, or a problem', () => {
		expect(proposalState(props({ dataset: null, target: null, proposal: null }))).toEqual({ kind: 'no-dataset' });
		expect(proposalState(props({ boundary: null, proposal: null }))).toEqual({ kind: 'no-boundary' });
		expect(proposalState(props({ proposal: { problem: 'the grid has no value inside the boundary' } }))).toEqual({ kind: 'problem', problem: 'the grid has no value inside the boundary' });
	});

	it('is ready with the target, the row and the coverage', () => {
		expect(proposalState(props())).toEqual({ kind: 'ready', target: 'pe', proposed: BASE, annualMm: 1335, coverage: 1, cells: 4 });
	});
});

describe('the saved row', () => {
	it('is the monthly PE row for reference ET (none under pan coefficient × A-pan) and the A-pan row for A-pan', () => {
		expect(savedRow(props(), 'pe')).toBeNull();
		expect(savedRow(props({ settings: { apanMm: BASE, peKind: 'monthly', peMm: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } }), 'pe')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(savedRow(props({ settings: { apanMm: BASE, peKind: 'pan', peMm: null } }), 'apan')).toEqual(BASE);
	});

	it('matches the proposal to 0.05 mm a month', () => {
		expect(sameAsSaved(null, BASE)).toBe(false);
		expect(sameAsSaved(BASE.map((v) => v + 0.04), BASE)).toBe(true);
		expect(sameAsSaved(BASE.map((v, i) => (i === 5 ? v + 0.1 : v)), BASE)).toBe(false);
	});
});

describe('the implied pan coefficient', () => {
	it('is ET₀ ÷ A-pan per month, none where the A-pan row is 0, and flags months outside the range', () => {
		const apan = BASE.map((v, i) => (i === 11 ? 0 : v / 0.7));
		const k = impliedPanCoefficient(BASE, apan);
		expect(k.slice(0, 3)).toEqual([0.7, 0.7, 0.7]);
		expect(k[11]).toBeNull();
		expect(outsidePanRange([0.7, 0.5, null, 0.9], 0.6, 0.85)).toEqual([1, 3]);
	});
});

it('coverageText and acceptedText say where the values came from', () => {
	expect(coverageText(0.874, 1)).toBe('1 grid cell; 87 % of the boundary has values');
	const a: EvaporationAccepted = {
		target: 'pe',
		monthlyMm: BASE,
		dataset: 'synthetic',
		kind: 'et0',
		source: 's',
		version: 'synthetic 1',
		method: 'm',
		coverage: 1,
		acceptedAt: '2026-10-02T08:00:00Z',
		current: true
	};
	expect(acceptedText(a)).toMatch(/^GR4J’s monthly PE came from the map \(synthetic, synthetic 1\) on /);
	expect(acceptedText({ ...a, target: 'apan', current: false })).toMatch(/^Typed over since: the A-pan evaporation row came from the map/);
});
