import { describe, expect, it } from 'vitest';
import { asRunOfRiver, farmOperatingRules, placeholderPoolNote, readFarmSpec, runOfRiverNote } from './farms';
import { Report } from './report';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

// Ported from scripts/wbt-import/test_farm_ops.py (engine ≥ 0.16.0, docs/engine-audit.md Q5, N1, N2).
describe('farm operating rules', () => {
	it('Q5: the workbook min is the transfer minimum, not an operating level', () => {
		const report = new Report();
		expect(farmOperatingRules('Synthetic farm', { damMinPct: 0.3 }, report).damMinPct).toBe(0);
		expect(report.notes.length).toBe(1);
		expect(report.notes[0]!.message).toContain('transfer minimum');
		expect(report.notes[0]!.message).toBe(
			"farm Synthetic farm: [Farm spec] min dam % 0.3 is the workbook's transfer minimum (each transfer rule keeps its own); the dam's minimum operating level is left at 0 (docs/engine-audit.md Q5)"
		);
	});

	it('Q5: no note without a workbook min', () => {
		const report = new Report();
		expect(farmOperatingRules('Synthetic farm', {}, report).damMinPct).toBe(0);
		expect(report.notes).toEqual([]);
	});

	it('N1: return flow becomes efficiency with every loss returning', () => {
		const ops = farmOperatingRules('Synthetic farm', { returnFlowPct: 0.2 }, new Report());
		expect(ops.irrigationEfficiency).toBeCloseTo(0.8);
		expect(ops.irrigationEfficiency).toBe(1 - 0.2); // the same float arithmetic as the Python
		expect(ops.lossReturnFraction).toBe(1);
		expect(ops).not.toHaveProperty('returnFlowPct');
	});

	it('N1: no return flow is full efficiency and no return', () => {
		const ops = farmOperatingRules('Synthetic farm', { returnFlowPct: 0 }, new Report());
		expect([ops.irrigationEfficiency, ops.lossReturnFraction]).toEqual([1, 0]);
	});

	it('N1: all returning maps to the smallest efficiency', () => {
		expect(farmOperatingRules('Synthetic farm', { returnFlowPct: 1 }, new Report()).irrigationEfficiency).toBe(0.01);
	});

	it('N2: no surface area in the workbook', () => {
		const ops = farmOperatingRules('Synthetic farm', { damCapacityM3: 90000 }, new Report());
		expect([ops.damAreaFullM2, ops.damAreaExponent, ops.damSeepagePerDay]).toEqual([null, 0.7, 0]);
	});
});

describe('readFarmSpec', () => {
	it('reads each farm row and the method settings', () => {
		const t = readFarmSpec(new B023Workbook(syntheticB023().build()), new Report());
		expect([...t.farms.keys()]).toEqual(['Farm A', 'Farm B']);
		expect(t.farms.get('Farm A')).toMatchObject({ areaKm2: 5, areaHiKm2: 4, areaLoKm2: 1, flowShareManual: 0.5, selectedShare: 0.4, damCapacityM3: 100000, damMinPct: 0.3 });
		expect(t.method).toBe('area');
		expect(t.hiLoSplit).toEqual({ hi: 0.8, lo: 0.2 });
		expect(t.tolerance).toBe(0.0002);
	});

	it('maps Hi/Lo and Specific, and notes an unknown method', () => {
		expect(readFarmSpec(new B023Workbook(syntheticB023().set('Farm spec', 'M27', 'Hi/Lo').build()), new Report()).method).toBe('hiLo');
		const report = new Report();
		expect(readFarmSpec(new B023Workbook(syntheticB023().set('Farm spec', 'M27', 'Pitman').build()), report).method).toBe('area');
		expect(report.notes.map((n) => n.message)).toEqual(["unknown fragmentation method 'Pitman'; using area"]);
	});

	it('defaults a blank hi/lo split to 0.5 / 0.5', () => {
		const b = syntheticB023().set('Farm spec', 'I27', null).set('Farm spec', 'J27', null);
		expect(readFarmSpec(new B023Workbook(b.build()), new Report()).hiLoSplit).toEqual({ hi: 0.5, lo: 0.5 });
	});

	it('lists a blank share under the Specific method (the Python reads 0 without a word)', () => {
		const report = new Report();
		const b = syntheticB023().set('Farm spec', 'M27', 'Specific').set('Farm spec', 'L31', null);
		const t = readFarmSpec(new B023Workbook(b.build()), report);
		expect(t.method).toBe('manual');
		expect(t.farms.get('Farm B')!.flowShareManual).toBe(0);
		expect(report.unmapped).toEqual([expect.objectContaining({ code: 'flow-share-missing', element: 'Farm B', cell: 'L31', sheet: 'Farm spec' })]);
		// Not listed under the other methods, where the share isn't used.
		const other = new Report();
		readFarmSpec(new B023Workbook(syntheticB023().set('Farm spec', 'L31', null).build()), other);
		expect(other.unmapped).toEqual([]);
	});

	it('reads numeric text, and lists text that is not a number (imported as 0)', () => {
		const report = new Report();
		const b = syntheticB023().set('Farm spec', 'T30', '4320').set('Farm spec', 'P31', 'about 5000');
		const t = readFarmSpec(new B023Workbook(b.build()), report);
		expect(t.farms.get('Farm A')!.divertCapacityM3Day).toBe(4320);
		expect(t.farms.get('Farm B')!.damCapacityM3).toBe(0);
		expect(report.unmapped).toEqual([
			expect.objectContaining({ code: 'non-numeric-value', cell: 'P31', element: 'Farm B', text: 'about 5000', message: "[Farm spec] Dam capacity for Farm B (P31) holds 'about 5000', not a number; imported as 0" })
		]);
	});
});

// Ported from scripts/wbt-import/test_run_of_river.py (issue #54, 2d): the same cases and text.
describe('runOfRiverNote (run_of_river_note)', () => {
	const TAIL =
		'. b023 has no river abstraction, so a unit that pumps from the river is entered as a dummy dam; the app imports it ' +
		'as a farm dam, so its dam results (storage, spill, level) mean nothing (issue #54, 2d)';

	it('flags a pool with a large diversion', () => {
		expect(runOfRiverNote('Pump unit', 1, 0.4, 12960, 0.25)).toBe(
			'WARNING: farm Pump unit: probable run-of-river, for the modeller to confirm: its dam takes 100 % of the ' +
				'upstream inflow and is a pool of 0.4 m³ against a diversion capacity of 12960 m³/day' +
				TAIL
		);
	});

	it('flags a placeholder under 1 m³ without a diversion', () => {
		expect(runOfRiverNote('Pump unit', 1, 0.5, 0, 0)).toContain('and is a pool of 0.5 m³. b023');
	});

	it('flags a dam that holds a whole number of m³/s for one day', () => {
		expect(runOfRiverNote('River pool', 1, 259200, 0, 0)).toBe(
			'WARNING: farm River pool: probable run-of-river, for the modeller to confirm: its dam takes 100 % of the ' +
				"upstream inflow and holds exactly 3 m³/s for one day (259200 m³) and takes none of the farm's own runoff" +
				TAIL
		);
		expect(runOfRiverNote('One cumec', 1, 86400.4, 0, 0)).not.toBeNull();
	});

	it('leaves a real on-channel dam with all the upstream inflow alone', () => {
		// Negative controls: 100 % upstream inflow, but real storage.
		expect(runOfRiverNote('Farm dam', 1, 310000, 0, 0.35)).toBeNull();
		expect(runOfRiverNote('Farm dam', 1, 240000, 12960, 0)).toBeNull(); // not a whole day of m³/s
		expect(runOfRiverNote('Small dam', 1, 4000, 12960, 0.15)).toBeNull(); // 31 % of a day's diversion
		expect(runOfRiverNote('Rounded dam', 1, 432000, 12960, 0.2)).toBeNull(); // 5 m³/s x 1 day, but catches its runoff
	});

	it('leaves a pool just over 1 % of the diversion alone', () => {
		expect(runOfRiverNote('Pool', 1, 129.5, 12960, 0.25)).not.toBeNull();
		expect(runOfRiverNote('Pond', 1, 129.7, 12960, 0.25)).toBeNull();
	});

	it('leaves less than 100 % upstream inflow alone', () => {
		expect(runOfRiverNote('Off-channel', 0.99, 0.4, 12960, 0.25)).toBeNull();
		expect(runOfRiverNote('Off-channel', 0, 259200, 0, 0)).toBeNull();
		expect(runOfRiverNote('No dam', 0.5, 0, 12960, 0)).toBeNull();
	});

	// The engine lets a dam-less farm irrigate from the river routed to it, with no limit (issue #54).
	it('flags a farm with no dam that takes all the upstream inflow', () => {
		expect(runOfRiverNote('No dam', 1, 0, 12960, 0)).toBe(
			'WARNING: farm No dam: probable run-of-river, for the modeller to confirm: it has no dam but takes 100 % of the ' +
				'upstream inflow, and a farm without a dam irrigates straight from the river routed to it, with no pump limit. ' +
				'Set its supply rule to run of river with a pump capacity to cap it (issue #54, 2d)'
		);
	});
});

// Ported from scripts/wbt-import/test_run_of_river.py RunOfRiverOption (same text).
describe('asRunOfRiver (as_run_of_river): the run-of-river option', () => {
	const unit = (name: string, damCapacityM3: number) => ({ name, damCapacityM3, damInitialPct: 0.5, damSeepagePerDay: 0 });

	it('drops a dummy dam and gives the unit an uncapped river pump, keys after the existing ones as Python adds them', () => {
		const node = unit('River pool', 259200);
		const note = asRunOfRiver(node, false);
		expect(node).toEqual({ name: 'River pool', damCapacityM3: 0, damInitialPct: 0, damSeepagePerDay: 0, supplyRule: 'runOfRiver', pumpCapacityM3Day: null });
		expect(Object.keys(node)).toEqual(['name', 'damCapacityM3', 'damInitialPct', 'damSeepagePerDay', 'supplyRule', 'pumpCapacityM3Day']);
		expect(note).toBe(
			'WARNING: farm River pool: imported as run of river (--run-of-river): its 259200 m³ dummy dam is dropped, and a river pump ' +
				"takes its demand from the river below it. The workbook gives no pump capacity (b023 has none, and nothing there capped this unit's " +
				"take), so the pump is uncapped and each run warns; enter the capacity in the Network tab's Supply section (issue #54, 2c/2d)"
		);
	});

	it('rounds the dropped dam half up, and says a dam-less unit has no dam', () => {
		expect(asRunOfRiver(unit('Pool', 0.5), false)).toContain('its 1 m³ dummy dam is dropped');
		const none = unit('No dam', 0);
		expect(asRunOfRiver(none, false)).toContain('farm No dam: imported as run of river (--run-of-river): it has no dam, and a river pump');
		expect(none).toMatchObject({ damCapacityM3: 0, supplyRule: 'runOfRiver', pumpCapacityM3Day: null });
	});

	it('leaves a unit an enabled transfer draws on as a farm dam, and says why', () => {
		const node = unit('Source', 259200);
		const note = asRunOfRiver(node, true);
		expect(node).toEqual(unit('Source', 259200));
		expect(note).toBe(
			'WARNING: farm Source: not imported as run of river (--run-of-river): an enabled transfer draws on its dam, so it stays a ' +
				'farm dam; convert it by hand once the transfer is settled (issue #54, 2d)'
		);
	});
});

// Same cases and text as test_run_of_river.py PlaceholderPoolNote (issue #90 Q18).
describe('placeholder pool note', () => {
	it('flags a near-empty dam that takes less than all the upstream inflow', () => {
		expect(placeholderPoolNote('Pool', 0, 0.5, 0)).toBe(
			"WARNING: farm Pool: probable placeholder pool, for the modeller to confirm: its dam holds 0.5 m³, less than a " +
				"day's peak irrigation of one hectare, and takes 0 % of the upstream inflow, so it stores nothing from one day to " +
				'the next. If it is a placeholder, set the dam capacity to 0; if the unit pumps from the river, set its supply ' +
				'rule to run of river with a pump capacity (issue #90 Q18)'
		);
		expect(placeholderPoolNote('Tank', 0.5, 99.9, 0)).not.toBeNull();
		expect(placeholderPoolNote('Pool', 0.25, 129.5, 12960)).not.toBeNull();
	});

	it('leaves a real dam, no dam and a run-of-river candidate alone', () => {
		expect(placeholderPoolNote('Small dam', 0, 100, 0)).toBeNull();
		expect(placeholderPoolNote('Small dam', 0.5, 4000, 12960)).toBeNull();
		expect(placeholderPoolNote('No dam', 0, 0, 0)).toBeNull();
		expect(placeholderPoolNote('Dummy dam', 1, 0.5, 0)).toBeNull();
	});
});
