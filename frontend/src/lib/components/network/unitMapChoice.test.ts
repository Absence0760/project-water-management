// A unit's "Source of the MAP" choice (docs/ui.md § Network, docs/maps.md §
// MAP for each unit): which grid a source line is from, each grid's option for
// one unit (its MAP, or why not, in the proposal's words), the one-grid rule's
// switch (who switches, who blocks), the question before a pick, the notice
// after it, and typed by hand. The form itself is pinned by
// e2e/tests/unit-map-choice.spec.ts.
import { describe, expect, it } from 'vitest';
import { unitMapSource } from '@water-management/engine';
import type { UnitMapCandidate, UnitMapProposal } from '#lib/api/index.js';
import { MAP_GRID_NAMES, mapGridName } from '#lib/components/map/mapGridNames.js';
import { choiceOf, gridLabels, gridOptions, pickedNotice, pickNodeIds, pickQuestion, toTyped, type GridLoad } from './unitMapChoice';

const WAAS = { dataset: 'WAAS-SWCape-2007', version: '1.1' };
const CCWR = { dataset: 'Lynch-2004', version: '2004' };
const waasLine = unitMapSource(WAAS, 40);
const ccwrLine = unitMapSource(CCWR, 9);

const candidate = (g: { dataset: string; version: string }): UnitMapCandidate => ({ label: g.dataset, version: g.version, cellDeg: 0.01, synthetic: false, covered: 2, missing: [] });
const unit = (nodeId: string, mapMm: number, patch: Partial<UnitMapProposal['units'][number]> = {}): UnitMapProposal['units'][number] => ({
	nodeId,
	name: nodeId.toUpperCase(),
	featureId: `f-${nodeId}`,
	mapMm,
	cells: 4,
	coveredShare: 1,
	current: { mapMm: null, mapSource: null },
	same: false,
	...patch
});
const proposal = (g: { dataset: string; version: string }, patch: Partial<UnitMapProposal> = {}): UnitMapProposal => ({
	dataset: { label: g.dataset, version: g.version, source: 's', attribution: 's', cellDeg: 0.01, synthetic: false },
	coversAll: true,
	units: [unit('a', 812), unit('b', 790)],
	uncovered: [],
	withoutPolygon: [],
	refused: [],
	otherGrid: [],
	candidates: [candidate(WAAS), candidate(CCWR)],
	...patch
});
const read = (p: UnitMapProposal): GridLoad => ({ kind: 'read', proposal: p });
const both = [candidate(WAAS), candidate(CCWR)];

describe('the grids’ names', () => {
	it('names the WAAS 2007 and CCWR grids by their short names, any other by its label', () => {
		expect(MAP_GRID_NAMES).toEqual({ 'WAAS-SWCape-2007': 'WAAS 2007 MAP', 'Lynch-2004': 'CCWR MAP' });
		expect(mapGridName('Lynch-2004')).toBe('CCWR MAP');
		expect(mapGridName('synthetic')).toBe('synthetic');
		expect(gridLabels([{ label: 'synthetic' }, { label: 'Lynch-2004' }])).toEqual(['WAAS-SWCape-2007', 'Lynch-2004', 'synthetic']);
	});
});

describe('choiceOf: which grid a source line is from', () => {
	const labels = gridLabels(both);
	it('reads a grid’s line as that grid, by the engine’s recognition', () => {
		expect(choiceOf(waasLine, labels)).toEqual({ kind: 'grid', label: 'WAAS-SWCape-2007', citation: 'WAAS-SWCape-2007 1.1' });
		expect(choiceOf(ccwrLine, labels)).toEqual({ kind: 'grid', label: 'Lynch-2004', citation: 'Lynch-2004 2004' });
	});
	it('reads anything else as typed by hand', () => {
		expect(choiceOf('DWAF map', labels)).toEqual({ kind: 'typed' });
		expect(choiceOf('', labels)).toEqual({ kind: 'typed' });
		expect(choiceOf(null, labels)).toEqual({ kind: 'typed' });
	});
	it('keeps a grid no longer known as a grid, by its citation, and a longer label wins over one it starts with', () => {
		expect(choiceOf(unitMapSource({ dataset: 'old-grid', version: '1' }, 2), labels)).toEqual({ kind: 'grid', label: 'old-grid 1', citation: 'old-grid 1' });
		expect(choiceOf(unitMapSource({ dataset: 'g-2', version: '1' }, 2), ['g', 'g-2'])).toMatchObject({ label: 'g-2' });
	});
});

describe('gridOptions: each grid for one unit', () => {
	it('gives the unit’s MAP from each loaded grid, with its coverage below 100 %, the named grids first', () => {
		const loads = new Map([
			['WAAS-SWCape-2007', read(proposal(WAAS))],
			['Lynch-2004', read(proposal(CCWR, { units: [unit('a', 790, { coveredShare: 0.9335 }), unit('b', 700)] }))]
		]);
		const opts = gridOptions('a', both, loads);
		expect(opts.map((o) => [o.name, o.mapMm, o.covered, o.reason])).toEqual([
			['WAAS 2007 MAP', 812, null, null],
			['CCWR MAP', 790, '93.3 % covered', null]
		]);
	});

	it('offers a named grid that isn’t loaded, unpickable, and any other loaded grid after them', () => {
		const opts = gridOptions('a', [candidate({ dataset: 'synthetic', version: 'synthetic 1' })], new Map([['synthetic', read(proposal({ dataset: 'synthetic', version: 'synthetic 1' }))]]));
		expect(opts.map((o) => [o.name, o.reason])).toEqual([
			['WAAS 2007 MAP', 'Not loaded on this server.'],
			['CCWR MAP', 'Not loaded on this server.'],
			['synthetic', null]
		]);
	});

	it('says why a grid can’t give the unit a MAP, in the proposal’s own words', () => {
		const loads = new Map<string, GridLoad>([
			['WAAS-SWCape-2007', read(proposal(WAAS, { units: [unit('b', 790)], uncovered: [{ nodeId: 'a', name: 'A', coveredShare: 0.42, reason: 'the grid has values for only 42 % of the unit’s parcel (at least 90 % is needed)' }] }))],
			['Lynch-2004', { kind: 'reading' }]
		]);
		const [waas, ccwr] = gridOptions('a', both, loads);
		expect(waas!.reason).toBe('The grid has values for only 42 % of the unit’s parcel (at least 90 % is needed) (42 % with values).');
		expect(ccwr!.reason).toBe('Reading the grid…');
		const noPolygon = gridOptions('a', both, new Map([['WAAS-SWCape-2007', read(proposal(WAAS, { units: [unit('b', 790)], withoutPolygon: [{ nodeId: 'a', name: 'A' }] }))]]));
		expect(noPolygon[0]!.reason).toBe('The unit has no polygon on the map: draw or link its parcel on the Map first.');
		const several = gridOptions('a', both, new Map([['WAAS-SWCape-2007', read(proposal(WAAS, { units: [unit('b', 790)], refused: [{ nodeId: 'a', name: 'A', reason: 'the unit has several parcels on the map and none is its area' }] }))]]));
		expect(several[0]!.reason).toBe('The unit has several parcels on the map and none is its area.');
		const noArea = gridOptions('z', both, new Map([['WAAS-SWCape-2007', read(proposal(WAAS))]]));
		expect(noArea[0]!.reason).toBe('Only a unit with land (an area above 0) takes a MAP from a grid.');
		const failed = gridOptions('a', both, new Map([['Lynch-2004', { kind: 'error', message: 'Too many cells' } as GridLoad]]));
		expect(failed[1]!.reason).toBe('Couldn’t be read: Too many cells');
	});

	it('switches the other units on another grid this grid covers, never the typed or empty ones', () => {
		const p = proposal(CCWR, {
			units: [
				unit('a', 790, { current: { mapMm: 800, mapSource: 'DWAF map' } }),
				unit('b', 700, { current: { mapMm: 760, mapSource: waasLine } }),
				unit('c', 650, { current: { mapMm: 640, mapSource: 'a study, 1990–2010' } }),
				unit('d', 610, { current: { mapMm: 600, mapSource: ccwrLine } }),
				unit('e', 600)
			]
		});
		const [, ccwr] = gridOptions('a', both, new Map([['Lynch-2004', read(p)]]));
		expect(ccwr!.reason).toBeNull();
		expect(ccwr!.switches).toEqual([{ nodeId: 'b', name: 'B', from: 'WAAS 2007 MAP' }]);
		expect(pickNodeIds('a', ccwr!)).toEqual(['a', 'b']);
	});

	it('can’t be picked when a unit this grid doesn’t cover holds another grid’s MAP: that would mix two grids', () => {
		const p = proposal(CCWR, { units: [unit('a', 790)], otherGrid: [{ nodeId: 'b', name: 'B', mapSource: waasLine }] });
		const [, ccwr] = gridOptions('a', both, new Map([['Lynch-2004', read(p)]]));
		expect(ccwr!.reason).toBe('It would mix two grids: B (WAAS 2007 MAP) has a MAP from another grid that this one doesn’t cover. Type its MAP by hand, or clear it, on its form first.');
		// The unit itself on the other grid isn't in the way: it is the one being switched.
		const self = gridOptions('a', both, new Map([['Lynch-2004', read(proposal(CCWR, { units: [unit('b', 700)], uncovered: [{ nodeId: 'a', name: 'A', coveredShare: 0, reason: 'r' }], otherGrid: [{ nodeId: 'a', name: 'A', mapSource: waasLine }] }))]]));
		expect(self[1]!.reason).toBe('R.');
	});

	it('marks the grid the unit holds already', () => {
		const p = proposal(WAAS, { units: [unit('a', 812, { same: true, current: { mapMm: 812, mapSource: waasLine } })] });
		expect(gridOptions('a', both, new Map([['WAAS-SWCape-2007', read(p)]]))[0]).toMatchObject({ same: true, switches: [] });
	});
});

describe('the question before a pick, and the notice after it', () => {
	const opt = (patch = {}) => ({ label: 'Lynch-2004', name: 'CCWR MAP', mapMm: 790, covered: null, reason: null, same: false, switches: [], ...patch });

	it('asks nothing when the unit has no MAP, or a grid’s, and no other unit switches', () => {
		expect(pickQuestion({ name: 'A', mapMm: null, mapSource: null }, { kind: 'typed' }, opt())).toBeNull();
		expect(pickQuestion({ name: 'A', mapMm: 812, mapSource: waasLine }, { kind: 'grid', label: 'WAAS-SWCape-2007', citation: 'WAAS-SWCape-2007 1.1' }, opt())).toBeNull();
	});

	it('asks before replacing a typed MAP', () => {
		expect(pickQuestion({ name: 'A', mapMm: 800, mapSource: 'DWAF map' }, { kind: 'typed' }, opt())).toEqual({
			title: 'Replace the typed MAP?',
			message: 'A’s typed 800 mm (“DWAF map”) is replaced by 790 mm from CCWR MAP, saved straight to the model as one change in History.',
			confirmLabel: 'Use CCWR MAP'
		});
	});

	it('asks to switch every unit on the other grid, naming them', () => {
		const q = pickQuestion({ name: 'A', mapMm: null, mapSource: null }, { kind: 'typed' }, opt({ switches: [{ nodeId: 'b', name: 'B', from: 'WAAS 2007 MAP' }, { nodeId: 'c', name: 'C', from: 'WAAS 2007 MAP' }] }));
		expect(q).toEqual({
			title: 'Switch every unit to CCWR MAP?',
			message:
				'2 units use WAAS 2007 MAP now: B and C. They and A get their MAP from CCWR MAP, so the project keeps to one grid, saved straight to the model as one change in History. Units whose MAP is typed by hand, or that have none, keep what they have.',
			confirmLabel: 'Switch to CCWR MAP'
		});
		const one = pickQuestion({ name: 'A', mapMm: 800, mapSource: 'DWAF map' }, { kind: 'typed' }, opt({ switches: [{ nodeId: 'b', name: 'B', from: 'WAAS 2007 MAP' }] }));
		expect(one!.message).toBe(
			'1 unit uses WAAS 2007 MAP now: B. It and A get their MAP from CCWR MAP, so the project keeps to one grid, saved straight to the model as one change in History. A’s typed 800 mm (“DWAF map”) is replaced by 790 mm. Units whose MAP is typed by hand, or that have none, keep what they have.'
		);
	});

	it('says what the pick saved', () => {
		const a = (units: { nodeId: string; mapMm: number }[], changed: number) => ({ dataset: 'Lynch-2004', units: units.map((u) => ({ ...u, mapSource: ccwrLine })), changed, revisionId: null });
		expect(pickedNotice(a([{ nodeId: 'a', mapMm: 790 }], 1), 'a', 'A', 'CCWR MAP')).toBe('A’s MAP is now 790 mm from CCWR MAP, saved as one model change (History).');
		expect(pickedNotice(a([{ nodeId: 'a', mapMm: 790 }, { nodeId: 'b', mapMm: 700 }], 2), 'a', 'A', 'CCWR MAP')).toBe('A and 1 other unit now have their MAP from CCWR MAP, saved as one model change (History).');
		expect(pickedNotice(a([{ nodeId: 'a', mapMm: 790 }], 0), 'a', 'A', 'CCWR MAP')).toBe('A already had its MAP from CCWR MAP: nothing changed.');
	});
});

describe('toTyped: Typed by hand', () => {
	it('keeps the number and drops a grid’s source line, so the source is asked for', () => {
		const n = { mapMm: 812, mapSource: waasLine };
		toTyped(n);
		expect(n).toEqual({ mapMm: 812, mapSource: '' });
	});
	it('leaves a typed source, and no MAP, as they are', () => {
		const n = { mapMm: 800, mapSource: 'DWAF map' };
		toTyped(n);
		expect(n).toEqual({ mapMm: 800, mapSource: 'DWAF map' });
		const none = { mapMm: null, mapSource: null };
		toTyped(none);
		expect(none).toEqual({ mapMm: null, mapSource: null });
	});
});
