// A cap or full-allocation run's bound units, as a viewer kept from each
// registered volume reads them (issue #523 finding I, boundUnits.ts).
// Synthetic figures only.
import { describe, expect, it } from 'vitest';
import { ALLOCATION_SERIES_KEYS, boundUnits, seriesWithheld, warningWithoutVolume, withoutBoundUnits, withoutUnits } from './boundUnits.js';
import { redactRunAllocations } from './viewerUnits.js';
import { sweepForViewer } from '../sweeps/routes.js';
import type { SweepRow } from '../sweeps/store.js';

const VOLUME = 123_457;
const allocations = (mode: string) => ({
	mode,
	tolerance: 0.1,
	used: 1,
	notMatched: 0,
	nodes: [{ nodeId: 'a', name: 'Farm A', sources: [], ...(mode === 'fullAllocation' ? { scaled: [{ waterYear: 2021, demandM3: 1, registeredM3: VOLUME }] } : {}) }]
});
const summary = (mode: string) => ({
	farms: [
		{ nodeId: 'a', name: 'Farm A', avgDemandM3Day: VOLUME / 365 },
		{ nodeId: 'b', name: 'Farm B', avgDemandM3Day: 12 }
	],
	users: [],
	groundwaterAnnualUse: [{ nodeId: 'a', waterYear: 2021, boreholes: [] }],
	curtailment: { farms: [{ nodeId: 'a', fractionSupplied: 1 }, { nodeId: 'b', fractionSupplied: 0.5 }], totals: { days: 3 } },
	ewrAssurance: [{ nodeId: 'gauge', name: 'Weir' }],
	catchment: { ewrDaysNotMet: 4 },
	allocations: allocations(mode),
	warnings: [
		`allocation cap: at its maximum rate allocation x1 can take at most 31536 m³ in a year, less than its ${VOLUME} m³`,
		`allocation cap: allocation x2's maximum rate is 0, so it may take none of its ${VOLUME} m³ a year (a blank rate states none)`,
		'damStorageReset: unit "Farm B" storage 5 m³ is outside 0 … its capacity 4 m³ that day; clamped'
	]
});

describe('the units a run binds to their registered volume', () => {
	it('is every unit with an allocation in a cap or full-allocation run, and none in a compare-only run', () => {
		expect([...boundUnits(allocations('cap'))]).toEqual(['a']);
		expect([...boundUnits(allocations('fullAllocation'))]).toEqual(['a']);
		expect(boundUnits(allocations('none')).size).toBe(0);
		expect(boundUnits(null).size).toBe(0);
		// Already redacted: the marker names them.
		expect([...boundUnits({ mode: 'cap', nodes: [], withheldUnits: ['a'] })]).toEqual(['a']);
	});

	it('withholds every allocation series anywhere, and every series of a bound unit', () => {
		expect([...ALLOCATION_SERIES_KEYS].sort()).toEqual(['allocation_demand_factor', 'allocation_left_groundwater', 'allocation_left_surface', 'allocation_room_groundwater', 'allocation_room_surface']);
		const units = new Set(['a']);
		expect(seriesWithheld(units, 'a', 'supplied')).toBe(true);
		expect(seriesWithheld(units, 'b', 'allocation_room_surface')).toBe(true);
		expect(seriesWithheld(units, 'b', 'supplied')).toBe(false);
		expect(seriesWithheld(units, null, 'simulated_outflow')).toBe(false);
		expect(seriesWithheld(new Set(), 'a', 'demand')).toBe(false);
	});
});

describe('a run summary as that viewer reads it', () => {
	for (const mode of ['cap', 'fullAllocation'])
		it(`${mode}: no bound unit's entry anywhere, the units named, no volume in a warning; the rest stays`, () => {
			const out = withoutBoundUnits(summary(mode));
			expect(out.farms.map((f) => f.nodeId)).toEqual(['b']);
			expect(out.groundwaterAnnualUse).toEqual([]);
			expect(out.curtailment.farms.map((f) => f.nodeId)).toEqual(['b']);
			expect(out.curtailment.totals).toEqual({ days: 3 });
			expect(out.ewrAssurance).toEqual([{ nodeId: 'gauge', name: 'Weir' }]);
			expect(out.allocations).toMatchObject({ mode, nodes: [], withheldUnits: ['a'] });
			expect(JSON.stringify(out)).not.toContain(String(VOLUME));
			expect(JSON.stringify(out)).not.toContain(String(Math.round(VOLUME / 365)));
			expect(out.warnings[0]).toBe('allocation cap: at its maximum rate allocation x1 cannot take its registered volume in a year');
			expect(out.warnings[1]).toBe("allocation cap: allocation x2's maximum rate is 0, so it may take none of its registered volume (a blank rate states none)");
			expect(out.warnings[2]).toContain('storage 5 m³');
			// Idempotent: redacting a redacted summary changes nothing.
			expect(withoutBoundUnits(out)).toEqual(out);
		});

	it('a compare-only run comes back as it is (positive control)', () => {
		const s = summary('none');
		expect(withoutBoundUnits(s)).toBe(s);
	});

	it('redactRunAllocations leaves the bound units out before it empties the per-unit allocations', () => {
		const out = redactRunAllocations({ summary: summary('fullAllocation') }).summary as ReturnType<typeof summary> & { allocations: { withheldUnits: string[] } };
		expect(out.farms.map((f) => f.nodeId)).toEqual(['b']);
		expect(out.allocations.withheldUnits).toEqual(['a']);
	});

	it('a sweep on a full-allocation or cap base: each member without its bound units (the review’s accepted risk, closed)', () => {
		const sweep = { id: 's', members: [{ name: 'm', ops: [], summary: summary('fullAllocation') }] } as unknown as SweepRow;
		const text = JSON.stringify(sweepForViewer(sweep));
		expect(text).not.toContain(String(VOLUME));
		expect(text).not.toContain(String(Math.round(VOLUME / 365)));
		expect(JSON.stringify(sweep)).toContain(String(VOLUME));
	});
});

describe('a bound unit left out of anything else (an ensemble of the run)', () => {
	it('drops its array entries and its entries in a record by node id; other units and the catchment stay', () => {
		const ensemble = { members: [{ unitDemandM3Day: { a: VOLUME / 365, b: 12 }, reserve: { outlet: 0.9 } }], header: { farms: [{ nodeId: 'a' }, { nodeId: 'b' }] } };
		expect(withoutUnits(ensemble, new Set(['a']))).toEqual({ members: [{ unitDemandM3Day: { b: 12 }, reserve: { outlet: 0.9 } }], header: { farms: [{ nodeId: 'b' }] } });
		expect(withoutUnits(ensemble, new Set())).toBe(ensemble);
	});
});

describe('an allocation warning without its volume', () => {
	it('words any other allocation warning that quotes a figure in m³ without it, and leaves the rest alone', () => {
		expect(warningWithoutVolume('full allocation: "Farm A" took 1 234 567 m³')).toBe('full allocation: "Farm A" took a withheld volume');
		expect(warningWithoutVolume('rain: 3 days missing')).toBe('rain: 3 days missing');
	});
});
