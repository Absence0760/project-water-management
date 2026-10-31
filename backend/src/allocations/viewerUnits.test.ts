// A viewer's registered-water totals and the run they read (162, decision D3;
// viewerUnits.ts). The database side (who gets which rows, the 5-holder
// refusal) is in allocations.db.test.ts.
import { compareAllocations, registeredUseRow, ALLOCATIONS_NOT_ASSESSED, type EvidenceAllocations } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { ALTERNATIVE_CELL_WITHHELD, comparisonTotals, countsOthersYears, redactReportAllocations, redactRunAllocations, volumeTotals, withheldAllocationOps, withoutAllocationIdentifiers, withoutOthersRegistered, type VolumeRow } from './viewerUnits.js';

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

	it('sums each unit’s modelled use per water year, as compareAllocations reads it, with no registered m³ and no status per year; one judgement for the run', () => {
		const rows = five({ volumeM3PerYear: 100 }).map((r, i) => ({ ...r, volumeM3PerYear: (i + 3) * 100 }));
		const t = comparisonTotals({ startDate: '2021-10-01', today: '2026-10-11', nodes: nodes.map((n) => ({ ...n, supplied: n.supplied.slice(0, days) })), tolerance: 0.1, rows });
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
		expect(s.years[0]!).toEqual({ waterYear: 2021, partial: false, modelledM3: s.years[0]!.modelledM3 });
		// The same five rows in force all through, none dominating: one count for the run (the year is over the band).
		expect(s.judgement).toEqual({ wholeYears: 1, within: 0, outside: 1 });
		expect(JSON.stringify(t)).not.toContain('Unit');
		expect(JSON.stringify(t)).not.toMatch(/registered/i);
		expect(JSON.stringify(t)).not.toContain(String(Math.round(want('registeredM3'))));
	});

	it('#523 G and round 6: no judgement for a run whose rows in force change during it, or fail the 5-holder or dominance rule', () => {
		// One holder since 2005 (123 457 m³/a), four from 2023-10-01: the rows in force change in the run.
		const later = [row({ holders: 5, volumeM3PerYear: 123_457, validFrom: '2005-10-01' }), ...five({ holders: 5, volumeM3PerYear: 50_000, validFrom: '2023-10-01' }).slice(0, 4).map((r, i) => ({ ...r, nodeId: `n${i + 2}` }))];
		const t = comparisonTotals({ startDate: '2021-10-01', today: '2026-10-11', nodes, tolerance: 0.1, rows: later });
		expect(t.sources[0]!.judgement).toBeNull();
		expect(t.sources[0]!.years.map((y) => Object.keys(y).sort())).toEqual(new Array(3).fill(['modelledM3', 'partial', 'waterYear']));
		// The same rows all through, but one dominates: none either.
		const dominated = [row({ volumeM3PerYear: 900_000 }), ...five({ volumeM3PerYear: 1 }).slice(0, 4).map((r, i) => ({ ...r, nodeId: `n${i + 2}` }))];
		expect(comparisonTotals({ startDate: '2021-10-01', today: '2026-10-11', nodes, tolerance: 0.1, rows: dominated }).sources[0]!.judgement).toBeNull();
		// Steady and even, but today's total also holds an unmatched row: the judgement would be over other rows (L).
		const steady = five({ volumeM3PerYear: 50_000 });
		expect(comparisonTotals({ startDate: '2021-10-01', today: '2026-10-11', nodes, tolerance: 0.1, rows: [...steady, row({ nodeId: null, volumeM3PerYear: 77_777 })] }).sources[0]!.judgement).toBeNull();
		// …or rows in force through the run that have ended by today.
		const ended = steady.map((r) => ({ ...r, validTo: '2025-09-30' }));
		expect(comparisonTotals({ startDate: '2021-10-01', today: '2026-10-11', nodes, tolerance: 0.1, rows: ended }).sources[0]!.judgement).toBeNull();
		// Control: five steady, even holders, today's total's rows.
		expect(comparisonTotals({ startDate: '2021-10-01', today: '2026-10-11', nodes, tolerance: 0.1, rows: steady }).sources[0]!.judgement).not.toBeNull();
	});

	it('#523 L/M: no registered m³ in any year, so neither today’s total less a year nor one year less the next gives a holder’s volume', () => {
		// L: 5 holders on the run's units and a sixth unmatched (no unit); M: a sixth from 2022-10-01.
		const matched = five({ holders: 6, volumeM3PerYear: 50_000 });
		const unmatched = row({ holders: 6, nodeId: null, volumeM3PerYear: 123_457 });
		const later = row({ holders: 6, nodeId: 'n6', volumeM3PerYear: 123_457, validFrom: '2022-10-01' });
		for (const rows of [[...matched, unmatched], [...matched, later]]) {
			const t = comparisonTotals({ startDate: '2021-10-01', today: '2026-10-11', nodes, tolerance: 0.1, rows });
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
		// A cap run: its verdicts and counts only (#523 I, verdictsOnly.test.ts).
		expect(out.summary.allocations).toEqual({ mode: 'cap', tolerance: 0.1, used: 1, notMatched: 0, nodes: [], verdictsOnly: true });
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

	it('cuts § 4’s combined dam whose yields rest on the registered volumes to its direction, on compare-only runs too; the other dam stays (evidence-26)', () => {
		const m = { baseline: 50_000, combined: 40_000, change: -10_000, sumOfSingles: -10_000, interaction: 0 };
		const dam = (nodeId: string, onVolumes: boolean) => ({ nodeId, name: nodeId, firmYield: m, reliability: m, verdict: { firmYield: 'lower', reliability: 'lower' }, onVolumes });
		const report = {
			version: 'evidence-26',
			cumulative: { combined: { notAssessed: null, dams: [dam('capped', true), dam('plain', false)] } },
			appendix: { baselineInputs: null },
			summaries: { baseline: null, application: null }
		};
		const out = redactReportAllocations(report as never) as unknown as typeof report;
		expect(out.cumulative.combined.dams).toEqual([
			{ nodeId: 'capped', name: 'capped', verdict: { firmYield: 'lower', reliability: 'lower' }, onVolumes: true, firmYield: null, reliability: null, withheld: true },
			dam('plain', false)
		]);
		expect(report.cumulative.combined.dams[0]!.firmYield).toBe(m);
	});

	it('gives the mitigation alternatives (evidence-26) without another unit’s volume: their ops, the registered-use cell, and every figure but a count of one that rests on a cap', () => {
		const cell = (value: number) => ({ value, change: { run: 1, band: null, bandNote: 'no band', worse: null }, notAssessed: null, note: null });
		const vol = (nodeId: string) => ({ op: 'allocation.set', allocation: { id: `a-${nodeId}`, nodeId, volumeM3PerYear: 1000 } });
		const report = {
			version: 'evidence-26',
			mode: 'application',
			appendix: { baselineInputs: null },
			summaries: { baseline: null, application: null },
			rows: [
				{ id: 'ewrDays', alternatives: [cell(10), cell(11)] },
				{ id: 'outflowMar', alternatives: [cell(2), cell(3)] },
				{ id: 'registeredUse', alternatives: [cell(1), cell(1)] }
			],
			alternatives: [
				{ label: 'Smaller dam', allocationMode: 'compare', ops: [{ index: 0, class: 'proposal', op: vol('own') }, { index: 1, class: 'baseline', op: vol('theirs') }] },
				{ label: 'Capped', allocationMode: 'cap', ops: [] }
			]
		};
		const out = redactReportAllocations(report as never, ['own']) as unknown as typeof report;
		expect(out.alternatives[0]!.ops.map((o) => o.index)).toEqual([0]);
		const row = (id: string) => out.rows.find((r) => r.id === id)!.alternatives;
		// A count stays under both; a volume-bearing figure only under the one not on a cap; the registered-use cell under neither.
		expect(row('ewrDays')).toEqual([cell(10), cell(11)]);
		expect(row('outflowMar')).toEqual([cell(2), ALTERNATIVE_CELL_WITHHELD]);
		expect(row('registeredUse')).toEqual([ALTERNATIVE_CELL_WITHHELD, ALTERNATIVE_CELL_WITHHELD]);
		// The original isn't changed; a report with none is left without any.
		expect(report.alternatives[0]!.ops).toHaveLength(2);
		expect(redactReportAllocations({ ...report, alternatives: [] } as never)).not.toHaveProperty('rows.0.alternatives.0.notAssessed', ALTERNATIVE_CELL_WITHHELD.notAssessed);
	});
});

describe('§ 5 for a viewer kept from each volume (#523 K/L/M)', () => {
	it('leaves out the totals of other units’ registered m³ (each year, the means, the cap) and their status and counts (round 6), keeping their modelled use and the applicant’s own units', () => {
		const y = { waterYear: 2021, days: 365, yearDays: 365, partialA: false, partialB: false, registeredA: 373_457, modelledA: 9, statusA: 'under', registeredB: 250_000, modelledB: 8, statusB: 'under' };
		const src = { waterSource: 'surface', years: [y], countsA: null, countsB: null, meanModelledA: 9, meanRegisteredA: 373_457, meanModelledB: 8, meanRegisteredB: 250_000, capA: null, capB: null };
		const own = { nodeId: 'own', name: 'Mine', kind: 'farm', own: true, onlyIn: null, sources: [{ ...src, meanRegisteredA: 1_234, meanRegisteredB: 1_234, years: [{ ...y, registeredA: 1_234, registeredB: 1_234 }] }] };
		const total = { nodeId: 'others:surface', name: 'Other registered users (5 units)', aggregate: 5, kind: 'farm', own: false, onlyIn: null, sources: [src] };
		const report = { allocations: { units: [own, total] }, appendix: { baselineInputs: null }, summaries: { baseline: null, application: null } };
		const out = redactReportAllocations(report as never) as unknown as { allocations: { othersRegisteredWithheld?: true; units: (typeof total)[] } };
		expect(out.allocations.othersRegisteredWithheld).toBe(true);
		const t = out.allocations.units[1]!.sources[0]!;
		expect([t.meanRegisteredA, t.meanRegisteredB, t.years[0]!.registeredA, t.years[0]!.registeredB, t.years[0]!.statusA, t.years[0]!.statusB, t.countsA, t.years[0]!.modelledA]).toEqual([
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			9
		]);
		expect(out.allocations.units[0]!.sources[0]!.years[0]!.statusA).toBe('under');
		expect(out.allocations.units[0]!.sources[0]!.years[0]!.registeredA).toBe(1_234);
		expect(JSON.stringify(out)).not.toMatch(/373457|250000/);
		// The input isn't changed; a § 5 with no total of other units is passed through.
		expect(total.sources[0]!.years[0]!.registeredA).toBe(373_457);
		expect(withoutOthersRegistered({ units: [own] } as never)).toEqual({ units: [own] });
	});

	it('round 6: page 1’s "above the registered volume" flag no longer counts the totals’ years; rebuilt from the own units, or gone', () => {
		const counts = (over: number) => ({ wholeYears: 5, over, within: 5 - over, under: 0, noVolume: 0 });
		const src = (over: number) => ({ waterSource: 'surface', years: [], countsA: counts(over), countsB: null });
		const flag = { id: 'allocationsOver', level: 'caution', text: 'The baseline’s modelled use … Other registered users (5 units), surface water, 3 of 5 whole water years (§ 5).' };
		const report = (ownOver: number) => ({
			mode: 'baseline',
			flags: [{ id: 'other', level: 'count', text: 'kept' }, flag],
			allocations: { toleranceA: 0.1, toleranceB: null, units: [{ nodeId: 'own', name: 'Mine', own: true, sources: [src(ownOver)] }, { nodeId: 'others:surface', name: 'Other registered users (5 units)', aggregate: 5, own: false, sources: [src(3)] }] },
			appendix: { baselineInputs: null },
			summaries: { baseline: null, application: null }
		});
		const none = redactReportAllocations(report(0) as never) as unknown as { flags: { id: string; text: string }[] };
		expect(none.flags.map((f) => f.id)).toEqual(['other']);
		const mine = redactReportAllocations(report(2) as never) as unknown as { flags: { id: string; text: string }[] };
		expect(mine.flags[1]!.text).toContain('Mine (the applicant’s), surface water, 2 of 5');
		expect(mine.flags[1]!.text).not.toContain('Other registered users');
	});

	it('#523 R5-2: on a side whose run caps or fully allocates, also leaves out the totals’ modelled use and its mean', () => {
		const y = { waterYear: 2021, registeredA: 10, modelledA: 9, statusA: 'within', registeredB: 10, modelledB: 10, statusB: 'within' };
		const src = { waterSource: 'surface', years: [y], countsA: { wholeYears: 1 }, countsB: { wholeYears: 1 }, meanModelledA: 9, meanRegisteredA: 10, meanModelledB: 10, meanRegisteredB: 10 };
		const al = { modeA: 'none', modeB: 'fullAllocation', units: [{ nodeId: 'others:surface', aggregate: 5, sources: [src] }] };
		const out = withoutOthersRegistered(al as never) as unknown as typeof al & { othersUseWithheld?: true };
		const s = out.units[0]!.sources[0]!;
		expect(out.othersUseWithheld).toBe(true);
		expect([s.meanModelledB, s.countsB, s.years[0]!.modelledB, s.years[0]!.statusB]).toEqual([null, null, null, null]);
		// The compare-only side keeps its modelled use (control); no side keeps a status (round 6).
		expect([s.meanModelledA, s.years[0]!.modelledA, s.years[0]!.statusA, s.countsA]).toEqual([9, 9, null, null]);
		const cap = withoutOthersRegistered({ ...al, modeA: 'cap', modeB: null } as never) as unknown as typeof al;
		expect([cap.units[0]!.sources[0]!.years[0]!.modelledA, cap.units[0]!.sources[0]!.years[0]!.modelledB]).toEqual([null, 10]);
	});
});

describe('page 1’s "Registered vs modelled use" row for a viewer kept from each volume (#523 G1c)', () => {
	const counts = (wholeYears: number, over: number) => ({ wholeYears, over, within: wholeYears - over, under: 0, noVolume: 0 });
	const src = (a: number, b: number | null) => ({ waterSource: 'surface', years: [], countsA: counts(10, a), countsB: b === null ? null : counts(10, b), meanModelledA: null, meanRegisteredA: null, meanModelledB: null, meanRegisteredB: null, capA: null, capB: null });
	const own = { nodeId: 'own', name: 'Mine', kind: 'farm', own: true, onlyIn: null, sources: [src(2, 3)] };
	const total = { nodeId: 'others:surface', name: 'Other registered users (5 units)', aggregate: 5, kind: 'farm', own: false, onlyIn: null, sources: [src(0, 0)] };
	/** § 5 as the engine builds it: `unitYears` counted unit by unit before the totals, here the own unit's 2 / 3 and 7 / 6 of four other units' 40 years. */
	const section = (units: unknown[], judgedOthers: number, overOthers: [number, number]) =>
		({
			notAssessed: null,
			modeA: 'none',
			modeB: 'none',
			toleranceA: 0.1,
			toleranceB: 0.1,
			units,
			notMatchedA: 0,
			notMatchedB: 0,
			othersLeftOut: 0,
			unitYears: { overA: 2 + overOthers[0], judgedA: 10 + judgedOthers, overB: 3 + overOthers[1], judgedB: 10 + judgedOthers }
		}) as unknown as EvidenceAllocations;
	const report = (al: EvidenceAllocations) => ({
		mode: 'application',
		rows: [{ id: 'reserve' }, registeredUseRow(al, true)],
		allocations: al,
		appendix: { baselineInputs: null },
		summaries: { baseline: null, application: null }
	});

	it('counts the applicant’s own units only, in the row and in unitYears; the editor’s row counts every unit (control)', () => {
		const al = section([own, total], 40, [7, 6]);
		const r = report(al);
		// Control: as built, the row counts the other units' years too.
		const built = r.rows[1] as ReturnType<typeof registeredUseRow>;
		expect([built.baseline, built.application]).toEqual([9, 9]);
		expect(countsOthersYears(r as never)).toBe(true);
		const out = redactReportAllocations(r as never) as unknown as typeof r;
		const row = out.rows[1] as ReturnType<typeof registeredUseRow>;
		expect(out.rows[0]).toEqual({ id: 'reserve' });
		expect([row.id, row.baseline, row.application, row.change?.run, row.notAssessed]).toEqual(['registeredUse', 2, 3, 1, null]);
		expect(row.note).toMatch(/^2 of 10 unit-years judged; application 3 of 10/);
		expect(row.basis).toContain('summed over the applicant’s own units');
		expect(out.allocations.unitYears).toEqual({ overA: 2, judgedA: 10, overB: 3, judgedB: 10 });
		expect(JSON.stringify(out.rows)).not.toMatch(/\b(50|9)\b/);
		// The input isn't changed.
		expect(al.unitYears).toEqual({ overA: 9, judgedA: 50, overB: 9, judgedB: 50 });
	});

	it('with no unit of the applicant’s own (a team scenario, baseline evidence), the row is withheld, whether the others are in a total or left out', () => {
		for (const al of [section([total], 40, [7, 6]), { ...section([], 40, [7, 6]), othersLeftOut: 4 }]) {
			const out = redactReportAllocations(report(al as EvidenceAllocations) as never) as unknown as ReturnType<typeof report>;
			const row = out.rows[1] as ReturnType<typeof registeredUseRow>;
			expect([row.baseline, row.application, row.change?.run, row.notAssessed, row.note]).toEqual([null, null, null, ALLOCATIONS_NOT_ASSESSED.othersWithheld, null]);
			expect(out.allocations.unitYears).toEqual({ overA: 0, judgedA: 0, overB: 0, judgedB: 0 });
		}
	});

	it('countsOthersYears: false when the row counts the listed units alone, or there is nothing to judge', () => {
		const mine = section([own, total], 0, [0, 0]);
		expect(countsOthersYears(report(mine) as never)).toBe(false);
		expect(countsOthersYears(report({ ...section([total], 40, [7, 6]), notAssessed: 'none' } as EvidenceAllocations) as never)).toBe(false);
		// A document before evidence-15: no unitYears, every unit listed.
		expect(countsOthersYears({ mode: 'application', allocations: { ...mine, unitYears: undefined } } as never)).toBe(false);
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
