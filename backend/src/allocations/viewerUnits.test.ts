// A viewer's registered-water totals and the run they read (162, decision D3;
// viewerUnits.ts). The database side (who gets which rows, the 5-holder
// refusal) is in allocations.db.test.ts.
import { compareAllocations } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { comparisonTotals, redactReportAllocations, redactRunAllocations, volumeTotals, withheldAllocationOps, withoutAllocationIdentifiers, withoutOthersRegistered, type VolumeRow } from './viewerUnits.js';

let nextHolder = 0;
const key = () => `k${++nextHolder}`;
/** A row; each its own holder unless `holder` says. */
const row = (o: Partial<VolumeRow>): VolumeRow => ({
	waterSource: 'surface',
	holders: 6,
	holder: key(),
	nodeId: 'n1',
	volumeM3PerYear: 1000,
	storageM3: null,
	waterUse: '21a',
	validFrom: null,
	validTo: null,
	...o
});
const five = (o: Partial<VolumeRow> = {}) => Array.from({ length: 5 }, (_, i) => row({ nodeId: `n${i + 1}`, ...o }));

describe('volumeTotals', () => {
	it('sums the takes and storage in force on the day, per water source, a storage-only row as storage only', () => {
		const rows = [
			...five({ volumeM3PerYear: 1000, storageM3: 500 }),
			row({ nodeId: 'n6', waterUse: '21b', volumeM3PerYear: 0, storageM3: 700 }),
			// Lapsed before the day, and not yet in force: neither counts.
			row({ nodeId: 'n7', volumeM3PerYear: 9e6, storageM3: 9e6, validTo: '2020-12-31' }),
			row({ nodeId: 'n8', volumeM3PerYear: 9e6, validFrom: '2030-01-01' }),
			...five({ waterSource: 'groundwater', holders: 5, volumeM3PerYear: 60 })
		];
		expect(volumeTotals(rows, '2026-10-01')).toEqual([
			{ waterSource: 'surface', holders: 6, registeredM3PerYear: 5000, storageM3: 5 * 500 + 700 },
			{ waterSource: 'groundwater', holders: 5, registeredM3PerYear: 300, storageM3: null }
		]);
		// A source the database withheld (fewer than 5 holders) has no rows, so no total.
		expect(volumeTotals([], '2026-10-01')).toEqual([]);
	});

	it('#523 G: gives no total of the rows in force when fewer than 5 registered users hold them, though 5 or more hold the source', () => {
		// The review's repro: 5 holders of the source, 4 of them expired; the fifth's 123 457 m³/a mustn't come out.
		const rows = [
			row({ holders: 5, volumeM3PerYear: 123_457, storageM3: 4_321 }),
			...Array.from({ length: 4 }, (_, i) => row({ holders: 5, nodeId: `x${i}`, volumeM3PerYear: 50_000, storageM3: 1_000, validTo: '2024-09-30' }))
		];
		const [t] = volumeTotals(rows, '2026-10-11');
		expect(t).toEqual({ waterSource: 'surface', holders: 5, registeredM3PerYear: null, storageM3: null, storageWithheld: true });
		// One holder with five rows in force is still one holder.
		const one = Array.from({ length: 5 }, () => row({ holder: 'same', holders: 5, volumeM3PerYear: 10 }));
		expect(volumeTotals(one, '2026-10-11')[0]!.registeredM3PerYear).toBeNull();
		// Positive control: the day all five were in force, the total is theirs.
		expect(volumeTotals(rows, '2023-10-01')[0]).toEqual({ waterSource: 'surface', holders: 5, registeredM3PerYear: 323_457, storageM3: 8_321 });
		// Nothing in force: 0, which is nobody's volume.
		expect(volumeTotals(rows.map((r) => ({ ...r, validFrom: '2030-01-01' })), '2026-10-11')[0]).toEqual({ waterSource: 'surface', holders: 5, registeredM3PerYear: 0, storageM3: null });
	});
});

describe('comparisonTotals', () => {
	const days = 365;
	const nodes = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id, i) => ({ nodeId: id, name: `Unit ${id}`, kind: 'farm' as const, supplied: new Array<number>(365 + 365 + 366).fill(i + 1), groundwater: null, riverAbstraction: null }));

	it('sums each unit’s modelled use per water year and says how it compares with the registered volume, as compareAllocations reads them, with no registered m³', () => {
		const rows = five({ volumeM3PerYear: 100 }).map((r, i) => ({ ...r, volumeM3PerYear: (i + 3) * 100 }));
		const t = comparisonTotals({ startDate: '2021-10-01', nodes: nodes.map((n) => ({ ...n, supplied: n.supplied.slice(0, days) })), tolerance: 0.1, rows });
		expect(t.sources).toHaveLength(1);
		const s = t.sources[0]!;
		expect([s.waterSource, s.holders, s.units]).toEqual(['surface', 6, 5]);
		// n6 has no volume: its use isn't in the total.
		const c = compareAllocations({
			startDate: '2021-10-01',
			nodes: nodes.map((n) => ({ ...n, supplied: n.supplied.slice(0, days) })),
			tolerance: 0.1,
			allocations: rows.map((r, i) => ({ id: `x${i}`, nodeId: r.nodeId, waterSource: 'surface', volumeM3PerYear: r.volumeM3PerYear }))
		});
		const want = (k: 'modelledM3' | 'registeredM3') => c.nodes.filter((n) => n.nodeId !== 'n6').reduce((a, n) => a + n.surface.years[0]![k], 0);
		expect(s.years[0]!.modelledM3).toBeCloseTo(want('modelledM3'), 6);
		expect(s.years[0]!).toEqual({ waterYear: 2021, partial: false, modelledM3: s.years[0]!.modelledM3, status: 'over' });
		expect(JSON.stringify(t)).not.toContain('Unit');
		expect(JSON.stringify(t)).not.toMatch(/registered/i);
		expect(JSON.stringify(t)).not.toContain(String(Math.round(want('registeredM3'))));
	});

	it('#523 G: withholds even the status of a water year whose rows in force are fewer than 5 holders’; a year all five hold is the control', () => {
		// One holder since 2005 (123 457 m³/a), four from 2023-10-01: 2021 and 2022 are the one holder's alone.
		const rows = [row({ holders: 5, volumeM3PerYear: 123_457, validFrom: '2005-10-01' }), ...five({ holders: 5, volumeM3PerYear: 50_000, validFrom: '2023-10-01' }).slice(0, 4).map((r, i) => ({ ...r, nodeId: `n${i + 2}` }))];
		const t = comparisonTotals({ startDate: '2021-10-01', nodes, tolerance: 0.1, rows });
		const years = t.sources[0]!.years;
		expect(years.map((y) => [y.waterYear, y.withheld ?? false, y.status !== null])).toEqual([
			[2021, true, false],
			[2022, true, false],
			[2023, false, true]
		]);
		for (const y of years) expect(y.modelledM3).toBeGreaterThan(0);
	});

	it('#523 L/M: no registered m³ in any year, so neither today’s total less a year nor one year less the next gives a holder’s volume', () => {
		// L: 5 holders on the run's units and a sixth unmatched (no unit); M: a sixth from 2022-10-01.
		const matched = five({ holders: 6, volumeM3PerYear: 50_000 });
		const unmatched = row({ holders: 6, nodeId: null, volumeM3PerYear: 123_457 });
		const later = row({ holders: 6, nodeId: 'n6', volumeM3PerYear: 123_457, validFrom: '2022-10-01' });
		for (const rows of [[...matched, unmatched], [...matched, later]]) {
			const t = comparisonTotals({ startDate: '2021-10-01', nodes, tolerance: 0.1, rows });
			const text = JSON.stringify(t);
			for (const v of [123_457, 250_000, 373_457]) expect(text).not.toContain(String(v));
			// Today's total is the only registered m³ (positive control: it is shown, all six in force).
			expect(volumeTotals(rows, '2026-10-11')[0]!.registeredM3PerYear).toBe(373_457);
		}
	});
});

describe('the dominance rule (#523 O, provisional)', () => {
	it('withholds a sum one holder has more than 80 % of, or two more than 90 %, though 5 or more hold it', () => {
		const big = [row({ holders: 6, volumeM3PerYear: 900_000 }), ...Array.from({ length: 5 }, () => row({ holders: 6, volumeM3PerYear: 1 }))];
		expect(volumeTotals(big, '2026-10-11')[0]!.registeredM3PerYear).toBeNull();
		// Two large: 60 % and 35 % of the sum, the other four 5 %.
		const two = [row({ volumeM3PerYear: 600 }), row({ volumeM3PerYear: 350 }), ...Array.from({ length: 4 }, () => row({ volumeM3PerYear: 12.5 }))];
		expect(volumeTotals(two, '2026-10-11')[0]!.registeredM3PerYear).toBeNull();
		// Control: the largest 40 %, the two largest 70 %.
		const fair = [row({ volumeM3PerYear: 400 }), row({ volumeM3PerYear: 300 }), ...Array.from({ length: 3 }, () => row({ volumeM3PerYear: 100 }))];
		expect(volumeTotals(fair, '2026-10-11')[0]!.registeredM3PerYear).toBe(1000);
	});
});

describe('redactRunAllocations', () => {
	it('leaves the volumes out of the run’s model, inputs and summary, keeping the mode, band and counts', () => {
		const run = {
			id: 'r',
			model: { nodes: [], allocations: [{ id: 'a', volumeM3PerYear: 5 }] },
			inputs: { model: { allocations: [{ id: 'a', volumeM3PerYear: 5 }] }, settings: {} },
			summary: { farms: [], allocations: { mode: 'cap', tolerance: 0.1, used: 1, notMatched: 0, nodes: [{ nodeId: 'n1' }] } }
		};
		const out = redactRunAllocations(run);
		expect(out.model.allocations).toEqual([]);
		expect(out.inputs.model.allocations).toEqual([]);
		expect(out.summary.allocations).toEqual({ mode: 'cap', tolerance: 0.1, used: 1, notMatched: 0, nodes: [] });
		expect(out.id).toBe('r');
		// The original isn't changed (it may be cached or reused).
		expect(run.model.allocations).toHaveLength(1);
		// A run with none: its model gets an empty list, its summary stays as it was.
		const plain = { model: { nodes: [] as unknown[], allocations: undefined }, summary: { farms: [] as unknown[], allocations: null } };
		expect(redactRunAllocations(plain)).toEqual({ model: { nodes: [], allocations: [] }, summary: { farms: [], allocations: null } });
	});
});

describe('redactReportAllocations (issue #523 G1)', () => {
	it('leaves the volumes out of Appendix A.1’s model and both summaries, keeping § 5 and the rest; the original isn’t changed', () => {
		const report = {
			version: 'evidence-16',
			allocations: { units: [{ nodeId: 'own', own: true }], othersLeftOut: 2 },
			appendix: { baselineInputs: { settings: {}, model: { nodes: [{ id: 'n1' }], allocations: [{ id: 'a', volumeM3PerYear: 5 }] }, series: {} }, changes: [] },
			summaries: {
				baseline: { farms: [], allocations: { mode: 'none', tolerance: 0.1, used: 1, notMatched: 0, nodes: [{ nodeId: 'n1', name: 'Upper' }] } },
				application: { farms: [], allocations: { mode: 'none', tolerance: 0.1, used: 1, notMatched: 0, nodes: [{ nodeId: 'n1', name: 'Upper' }] } }
			}
		};
		const out = redactReportAllocations(report);
		expect(out.appendix.baselineInputs.model.allocations).toEqual([]);
		expect(out.appendix.baselineInputs.model.nodes).toEqual([{ id: 'n1' }]);
		expect(out.summaries.baseline.allocations.nodes).toEqual([]);
		expect(out.summaries.application.allocations).toMatchObject({ used: 1, nodes: [] });
		expect(out.allocations).toBe(report.allocations);
		expect(JSON.stringify(out)).not.toContain('Upper');
		expect(report.appendix.baselineInputs.model.allocations).toHaveLength(1);
		expect(report.summaries.baseline.allocations.nodes).toHaveLength(1);
		// Baseline evidence: no application summary.
		expect(redactReportAllocations({ ...report, summaries: { ...report.summaries, application: null } }).summaries.application).toBeNull();
	});
});

describe('§ 5 for a viewer kept from each volume (#523 K/L/M)', () => {
	it('leaves out the totals of other units’ registered m³ (each year, the means, the cap), keeping their status and modelled use and the applicant’s own units', () => {
		const y = { waterYear: 2021, days: 365, yearDays: 365, partialA: false, partialB: false, registeredA: 373_457, modelledA: 9, statusA: 'under', registeredB: 250_000, modelledB: 8, statusB: 'under' };
		const src = { waterSource: 'surface', years: [y], countsA: null, countsB: null, meanModelledA: 9, meanRegisteredA: 373_457, meanModelledB: 8, meanRegisteredB: 250_000, capA: null, capB: null };
		const own = { nodeId: 'own', name: 'Mine', kind: 'farm', own: true, onlyIn: null, sources: [{ ...src, meanRegisteredA: 1_234, meanRegisteredB: 1_234, years: [{ ...y, registeredA: 1_234, registeredB: 1_234 }] }] };
		const total = { nodeId: 'others:surface', name: 'Other registered users (5 units)', aggregate: 5, kind: 'farm', own: false, onlyIn: null, sources: [src] };
		const report = { allocations: { units: [own, total] }, appendix: { baselineInputs: null }, summaries: { baseline: null, application: null } };
		const out = redactReportAllocations(report as never) as unknown as { allocations: { othersRegisteredWithheld?: true; units: (typeof total)[] } };
		expect(out.allocations.othersRegisteredWithheld).toBe(true);
		const t = out.allocations.units[1]!.sources[0]!;
		expect([t.meanRegisteredA, t.meanRegisteredB, t.years[0]!.registeredA, t.years[0]!.registeredB, t.years[0]!.statusA, t.years[0]!.modelledA]).toEqual([null, null, null, null, 'under', 9]);
		expect(out.allocations.units[0]!.sources[0]!.years[0]!.registeredA).toBe(1_234);
		expect(JSON.stringify(out)).not.toMatch(/373457|250000/);
		// The input isn't changed; a § 5 with no total of other units is passed through.
		expect(total.sources[0]!.years[0]!.registeredA).toBe(373_457);
		expect(withoutOthersRegistered({ units: [own] } as never)).toEqual({ units: [own] });
	});

	it('#523 R5-2: on a side whose run caps or fully allocates, also leaves out the totals’ modelled use, means, status and counts', () => {
		const y = { waterYear: 2021, registeredA: 10, modelledA: 9, statusA: 'within', registeredB: 10, modelledB: 10, statusB: 'within' };
		const src = { waterSource: 'surface', years: [y], countsA: { wholeYears: 1 }, countsB: { wholeYears: 1 }, meanModelledA: 9, meanRegisteredA: 10, meanModelledB: 10, meanRegisteredB: 10 };
		const al = { modeA: 'none', modeB: 'fullAllocation', units: [{ nodeId: 'others:surface', aggregate: 5, sources: [src] }] };
		const out = withoutOthersRegistered(al as never) as unknown as typeof al & { othersUseWithheld?: true };
		const s = out.units[0]!.sources[0]!;
		expect(out.othersUseWithheld).toBe(true);
		expect([s.meanModelledB, s.countsB, s.years[0]!.modelledB, s.years[0]!.statusB]).toEqual([null, null, null, null]);
		// The compare-only side keeps them (control).
		expect([s.meanModelledA, s.years[0]!.modelledA, s.years[0]!.statusA]).toEqual([9, 9, 'within']);
		const cap = withoutOthersRegistered({ ...al, modeA: 'cap', modeB: null } as never) as unknown as typeof al;
		expect([cap.units[0]!.sources[0]!.years[0]!.modelledA, cap.units[0]!.sources[0]!.years[0]!.modelledB]).toEqual([null, 10]);
	});
});

describe('the ops a viewer kept from each volume doesn’t get (#523 G1)', () => {
	const set = (nodeId: string | null, v = 7) => ({ op: 'allocation.set', allocation: { id: `a-${nodeId}`, nodeId, waterSource: 'surface', volumeM3PerYear: v } }) as never;
	const ops = [{ op: 'node.set', nodeId: 'n1', field: 'damCapacityM3', value: 1 } as never, set('n1'), set('n2'), { op: 'allocation.remove', allocationId: 'a' } as never, set(null)];

	it('every allocation.set on a unit that isn’t `own` (none by default); a removal carries no volume and stays', () => {
		expect([...withheldAllocationOps(ops)]).toEqual([1, 2, 4]);
		expect([...withheldAllocationOps(ops, ['n1'])]).toEqual([2, 4]);
	});

	it('leaves them, and their classes, out of a run’s recorded scenario; the report’s ops and an unfolded mix too', () => {
		const run = { inputs: { model: { allocations: [] }, scenario: { ops, classified: ['proposal', 'baseline', 'baseline', 'baseline', 'baseline'] } } };
		const out = redactRunAllocations(run).inputs.scenario;
		expect(out.ops.map((o: { op: string }) => o.op)).toEqual(['node.set', 'allocation.remove']);
		expect(out.classified).toEqual(['proposal', 'baseline']);
		expect(run.inputs.scenario.ops).toHaveLength(5);
		const report = {
			appendix: { baselineInputs: { model: { allocations: [] } } },
			summaries: { baseline: null, application: null },
			ops: ops.map((op, index) => ({ index, class: 'baseline', op })),
			licenceImpactAuthorised: { status: 'ok', mix: { rows: [{ authorisation: 'licence', volumeM3PerYear: 70 }] } }
		};
		const r = redactReportAllocations(report as never, ['n1']) as typeof report;
		expect(r.ops.map((o) => o.index)).toEqual([0, 1, 3]);
		// A board built before evidence-17 has no folded mix: none.
		expect(r.licenceImpactAuthorised.mix).toBeNull();
		// Since: the folded one's shares in the full one's place, and no second copy.
		const shares = { rows: [{ authorisation: 'licence', sharePct: 100, entitlement: true }], entitlementPct: 100, folded: true, shares: true };
		const both = { ...report, licenceImpactAuthorised: { status: 'ok', mix: report.licenceImpactAuthorised.mix, mixFolded: shares } };
		const got = (redactReportAllocations(both as never) as typeof both).licenceImpactAuthorised;
		expect(got).toEqual({ status: 'ok', mix: shares });
		// An evidence-17 board's folded mix is in m³: served as its shares, with no m³ (#523 H/J).
		const m3 = {
			rows: [
				{ authorisation: 'registration', volumeM3PerYear: 600, entitlement: false },
				{ authorisation: 'licence', volumeM3PerYear: 200, entitlement: true }
			],
			entitlementM3PerYear: 200,
			totalM3PerYear: 800,
			folded: true
		};
		const old = (redactReportAllocations({ ...report, licenceImpactAuthorised: { status: 'ok', mix: report.licenceImpactAuthorised.mix, mixFolded: m3 } } as never) as typeof both).licenceImpactAuthorised;
		expect(old.mix).toEqual({
			rows: [
				{ authorisation: 'registration', sharePct: 75, entitlement: false },
				{ authorisation: 'licence', sharePct: 25, entitlement: true }
			],
			entitlementPct: 25,
			folded: true,
			shares: true
		});
		expect(JSON.stringify(old)).not.toMatch(/M3|800|600|200/);
	});
});

describe('withoutAllocationIdentifiers', () => {
	it('leaves an allocation event’s registration number and volume out, and keeps what was done', () => {
		const e = { kind: 'allocation.created', createdAt: 't', subject: { allocationId: 'a', registrationNo: 'R-1', nodeId: 'n', waterSource: 'surface', volumeM3PerYear: 5, waterUse: '21a' } };
		expect(withoutAllocationIdentifiers(e)).toEqual({ kind: 'allocation.created', createdAt: 't', subject: { allocationId: 'a', nodeId: 'n', waterSource: 'surface', waterUse: '21a' } });
		// The input is not changed.
		expect(e.subject.registrationNo).toBe('R-1');
		expect(withoutAllocationIdentifiers({ kind: 'allocation.deleted', subject: { allocationId: 'a', registrationNo: 'R-1' } }).subject).toEqual({ allocationId: 'a' });
	});

	it('leaves every other event, and a malformed one, as it is', () => {
		const run = { kind: 'run.created', subject: { registrationNo: 'kept' } };
		expect(withoutAllocationIdentifiers(run)).toBe(run);
		expect(withoutAllocationIdentifiers(null)).toBe(null);
		const noSubject = { kind: 'allocation.created' };
		expect(withoutAllocationIdentifiers(noSubject)).toBe(noSubject);
	});
});
