// End-to-end: scenario overrides (src/scenario, docs/scenarios.md) applied
// to a synthetic catchment, run, and compared with the base run
// (src/compare.ts compareRuns / diffInputs, docs/run-comparison.md). The
// expected differences are worked by hand: a demand scale multiplies the
// crop requirement (so D = F ÷ e) on exactly the months it names, a rain
// scale multiplies rain on exactly its days, and the comparison's deltas are
// B − A of the two runs' own summaries. A run compared with itself has no
// difference anywhere.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { testCatchment } from '../outlook/testCatchment';
import { applyScenario, type ScenarioOp } from '../scenario';
import { compareRuns, diffInputs, type MetricDelta, type RunInputsSnapshot } from '../compare';

function series(out: ModelOutput, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}:${key}`);
	return s.values;
}
const calMonth = (out: ModelOutput, t: number) => new Date((toEpochDay(out.startDate) + t) * 86_400_000).getUTCMonth() + 1;
const snapshot = (x: ModelInput): RunInputsSnapshot => ({ settings: x.settings, model: x.model, series: Object.fromEntries(Object.entries(x.series).map(([k, s]) => [k, { startDate: s!.startDate, length: s!.values.length, valuesSha256: JSON.stringify(s!.values) }])) });

/** Every MetricDelta inside a comparison, with its path. */
function deltas(v: unknown, path = ''): [string, MetricDelta][] {
	if (!v || typeof v !== 'object') return [];
	if ('a' in v && 'b' in v && 'delta' in v) return [[path, v as MetricDelta]];
	return Object.entries(v).flatMap(([k, x]) => deltas(x, `${path}.${k}`));
}

const BASE = testCatchment({ start: '2001-10-01', end: '2007-09-30', seed: 19, ewrM3Day: 800 });

function scenario(ops: ScenarioOp[]): { input: ModelInput; out: ModelOutput; problems: string[] } {
	const r = applyScenario(BASE, ops);
	return { input: r.input, out: runModel(r.input), problems: r.problems };
}

describe('outputs e2e: a run compared with itself (compare.ts)', () => {
	const a = runModel(BASE);
	const b = runModel(structuredClone(BASE));
	it('compareRuns: same period, every delta 0 or null, every farm paired, none only on one side', () => {
		const c = compareRuns({ ...a, label: 'A' }, { ...b, label: 'B' });
		expect(c.samePeriod).toBe(true);
		expect(c.engineVersionChanged).toBe(false);
		expect(c.onlyInA).toEqual([]);
		expect(c.onlyInB).toEqual([]);
		expect(c.farms.map((f) => [f.nodeIdA, f.nodeIdB, f.nameA])).toEqual([
			['a', 'a', null],
			['b', 'b', null]
		]);
		const all = deltas(c);
		expect(all.length).toBeGreaterThan(20);
		for (const [p, d] of all) {
			expect(d.a, p).toBe(d.b);
			if (d.a !== null) expect(d.delta, p).toBe(0);
		}
	});
	it('diffInputs: no change', () => {
		expect(diffInputs(snapshot(BASE), snapshot(structuredClone(BASE)))).toEqual([]);
	});
});

describe('outputs e2e: demand.scale (scenarios.md § Demand scaling)', () => {
	const base = runModel(BASE);
	it('0.7 in Nov, Dec and Jan multiplies each farm’s crop requirement and demand on exactly those months', () => {
		const { out, problems } = scenario([{ op: 'demand.scale', factor: 0.7, months: [11, 12, 1] }]);
		expect(problems).toEqual([]);
		for (const id of ['a', 'b']) {
			const f0 = series(base, id, 'crop_requirement');
			const f1 = series(out, id, 'crop_requirement');
			const d0 = series(base, id, 'demand');
			const d1 = series(out, id, 'demand');
			for (let t = 0; t < out.days; t++) {
				const k = [11, 12, 1].includes(calMonth(out, t)) ? 0.7 : 1;
				expect(Math.abs(f1[t]! - k * f0[t]!), `${id} F day ${t}`).toBeLessThanOrEqual(1e-9 * Math.max(1, f0[t]!));
				expect(Math.abs(d1[t]! - k * d0[t]!), `${id} D day ${t}`).toBeLessThanOrEqual(1e-9 * Math.max(1, d0[t]!));
			}
		}
		// The rain-runoff is untouched.
		expect(series(out, null, 'natural_flow')).toEqual(series(base, null, 'natural_flow'));
	});
	it('ops stack: two at 0.9 on Farm A are one at 0.81, and Farm B is untouched', () => {
		const two = scenario([
			{ op: 'demand.scale', factor: 0.9, nodeIds: ['a'] },
			{ op: 'demand.scale', factor: 0.9, nodeIds: ['a'] }
		]).out;
		const d0 = series(base, 'a', 'demand');
		const d2 = series(two, 'a', 'demand');
		for (let t = 0; t < two.days; t++) expect(Math.abs(d2[t]! - 0.81 * d0[t]!)).toBeLessThanOrEqual(1e-9 * Math.max(1, d0[t]!));
		expect(series(two, 'b', 'demand')).toEqual(series(base, 'b', 'demand'));
	});
	it('compareRuns of base vs scaled: each farm’s and the totals’ deltas are B − A of the summaries; demand falls', () => {
		const { out } = scenario([{ op: 'demand.scale', factor: 0.5 }]);
		const c = compareRuns(base, out);
		for (const f of c.farms) {
			const fa = base.summary.farms.find((x) => x.nodeId === f.nodeIdA)!;
			const fb = out.summary.farms.find((x) => x.nodeId === f.nodeIdB)!;
			expect(f.demandM3Day).toEqual({ a: fa.avgDemandM3Day, b: fb.avgDemandM3Day, delta: fb.avgDemandM3Day - fa.avgDemandM3Day });
			expect(f.demandM3Day.b!).toBeCloseTo(0.5 * f.demandM3Day.a!, 6);
			expect(f.suppliedM3Day.delta).toBe(fb.avgSuppliedM3Day - fa.avgSuppliedM3Day);
		}
		const sum = (o: ModelOutput, k: 'avgDemandM3Day' | 'avgSuppliedM3Day') => o.summary.farms.reduce((s, f) => s + f[k], 0);
		expect(c.totals.demandM3Day.delta).toBeCloseTo(sum(out, 'avgDemandM3Day') - sum(base, 'avgDemandM3Day'), 9);
		expect(c.totals.fractionSupplied.b).toBeCloseTo(sum(out, 'avgSuppliedM3Day') / sum(out, 'avgDemandM3Day'), 12);
		expect(c.catchment.meanNaturalFlowM3Day.delta).toBe(0);
		expect(c.catchment.ewrDaysNotMet.delta).toBe(out.summary.catchment.ewrDaysNotMet - base.summary.catchment.ewrDaysNotMet);
	});
});

describe('outputs e2e: series.scale and node.set (scenarios.md)', () => {
	const base = runModel(BASE);
	it('rain × 1.2 from 1 Jan 2004 to 29 Feb 2004 scales exactly those days of the catchment rain', () => {
		const r = applyScenario(BASE, [{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 1.2, from: '2004-01-01', to: '2004-02-29' }]);
		expect(r.problems).toEqual([]);
		const v0 = BASE.series.rain_catchment_mm!.values;
		const v1 = r.input.series.rain_catchment_mm!.values;
		const s = toEpochDay(BASE.series.rain_catchment_mm!.startDate);
		let scaled = 0;
		for (let t = 0; t < v0.length; t++) {
			const inside = s + t >= toEpochDay('2004-01-01') && s + t <= toEpochDay('2004-02-29');
			expect(v1[t], `day ${t}`).toBe(inside && v0[t] !== null ? v0[t]! * 1.2 : v0[t]);
			if (inside) scaled++;
		}
		expect(scaled).toBe(60);
		expect(r.applied[0]!.notes.join(' ')).toMatch(/60 day/);
		const out = runModel(r.input);
		const rf0 = series(base, null, 'rain_final');
		const rf1 = series(out, null, 'rain_final');
		const before = toEpochDay('2004-01-01') - toEpochDay(base.startDate);
		// Nothing before the scaled days moves.
		expect(rf1.slice(0, before)).toEqual(rf0.slice(0, before));
		expect(series(out, null, 'natural_flow').slice(0, before)).toEqual(series(base, null, 'natural_flow').slice(0, before));
		const c = compareRuns(base, out);
		expect(c.catchment.meanNaturalFlowM3Day.delta).toBeCloseTo(out.summary.catchment.meanNaturalFlowM3Day - base.summary.catchment.meanNaturalFlowM3Day, 9);
		expect(c.catchment.meanNaturalFlowM3Day.delta!).toBeGreaterThan(0);
		// The input diff names the series.
		expect(diffInputs(snapshot(BASE), snapshot(r.input)).some((ch) => ch.area === 'series')).toBe(true);
	});
	it('a range outside the record, or an inverted one, is a problem and changes nothing', () => {
		for (const op of [
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 2, from: '2010-01-01', to: '2011-01-01' },
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 2, from: '2005-01-01', to: '2004-01-01' }
		] as ScenarioOp[]) {
			const r = applyScenario(BASE, [op]);
			expect(r.problems).toHaveLength(1);
			expect(r.input.series.rain_catchment_mm!.values).toEqual(BASE.series.rain_catchment_mm!.values);
		}
	});
	it('node.set of a dam’s capacity: storage never exceeds the new capacity, the input diff lists it, the curve compares', () => {
		const r = applyScenario(BASE, [{ op: 'node.set', nodeId: 'a', field: 'damCapacityM3', value: 600_000 }]);
		expect(r.problems).toEqual([]);
		const out = runModel(r.input);
		expect(Math.max(...series(out, 'a', 'dam_storage'))).toBeLessThanOrEqual(600_000 + 1e-6);
		expect(Math.max(...series(out, 'a', 'dam_storage'))).toBeGreaterThan(300_000);
		const ch = diffInputs(snapshot(BASE), snapshot(r.input));
		expect(ch.some((x) => x.area === 'network' && x.kind === 'changed' && /Farm A/.test(x.text) && /capacity/i.test(x.text))).toBe(true);
		const c = compareRuns(base, out);
		const fa = c.farms.find((f) => f.nodeIdB === 'a')!;
		expect(fa.suppliedM3Day.delta!).toBeGreaterThanOrEqual(-1e-9);
	});
	it('a renamed farm (same id) is still paired, with its old name', () => {
		const r = applyScenario(BASE, [{ op: 'node.set', nodeId: 'b', field: 'name', value: 'Farm B renamed' }]);
		const c = compareRuns(base, runModel(r.input));
		const f = c.farms.find((x) => x.nodeIdB === 'b')!;
		expect([f.name, f.nameA]).toEqual(['Farm B renamed', 'Farm B']);
		expect(f.demandM3Day.delta).toBe(0);
	});
});

describe('outputs e2e: registered volumes in a scenario and in the input diff (§2.12a, scenarios.md § Registered volumes)', () => {
	const capped: ModelInput = {
		...BASE,
		settings: { ...BASE.settings, allocationMode: 'cap' },
		model: { ...BASE.model, allocations: [{ id: 'al-a', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 300_000 }] }
	};
	it('allocation.set lowers Farm A’s volume: the cap run takes no more than the new volume in any water year', () => {
		const r = applyScenario(capped, [{ op: 'allocation.set', allocation: { id: 'al-a', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 120_000 } }]);
		expect(r.problems).toEqual([]);
		const out = runModel(r.input);
		const sup = series(out, 'a', 'supplied');
		const d0 = toEpochDay(out.startDate);
		const perYear = new Map<number, number>();
		for (let t = 0; t < out.days; t++) {
			const date = new Date((d0 + t) * 86_400_000);
			const wy = date.getUTCMonth() >= 9 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
			perYear.set(wy, (perYear.get(wy) ?? 0) + sup[t]!);
		}
		for (const [wy, v] of perYear) expect(v, `${wy}`).toBeLessThanOrEqual(120_000 * (1 + 1e-9));
		expect(Math.max(...perYear.values())).toBeGreaterThan(119_000);
		// The input diff lists the volume changed; removing it lists it removed; a new one lists it added.
		const changed = diffInputs(snapshot(capped), snapshot(r.input));
		expect(changed.length).toBeGreaterThan(0);
		expect(changed.map((c) => c.text).join('\n')).toMatch(/120[ ,  ]?000/);
		const removed = applyScenario(capped, [{ op: 'allocation.remove', allocationId: 'al-a' }]);
		expect(removed.problems).toEqual([]);
		expect(diffInputs(snapshot(capped), snapshot(removed.input)).some((c) => c.kind === 'removed')).toBe(true);
		expect(diffInputs(snapshot(removed.input), snapshot(capped)).some((c) => c.kind === 'added')).toBe(true);
	});
	it('runs of different periods are not the same period; a farm present in one run only is listed on its side', () => {
		const a = runModel(BASE);
		const shorter = runModel({ ...BASE, settings: { ...BASE.settings, simulationEnd: '2006-09-30' } });
		expect(compareRuns(a, shorter).samePeriod).toBe(false);
		const r = applyScenario(BASE, [{ op: 'node.remove', nodeId: 'b' }]);
		expect(r.problems).toEqual([]);
		const c = compareRuns(a, runModel(r.input));
		expect(c.onlyInA.map((f) => f.nodeId)).toEqual(['b']);
		expect(c.onlyInB).toEqual([]);
		expect(c.farms.map((f) => f.nodeIdA)).toEqual(['a']);
		// Totals sum over the farms each run has.
		expect(c.totals.demandM3Day.a).toBeCloseTo(a.summary.farms.reduce((s, f) => s + f.avgDemandM3Day, 0), 9);
	});
	it('a copied project (fresh ids, same names) pairs its farms by name', () => {
		const copy: ModelInput = structuredClone(BASE);
		const ids: Record<string, string> = { g: 'g2', a: 'a2', b: 'b2' };
		copy.model.nodes = copy.model.nodes.map((n) => ({ ...n, id: ids[n.id]!, downstreamNodeId: n.downstreamNodeId ? ids[n.downstreamNodeId]! : null }));
		copy.model.cropAreas = copy.model.cropAreas.map((c) => ({ ...c, nodeId: ids[c.nodeId]! }));
		const a = runModel(BASE);
		const b = runModel(copy);
		const c = compareRuns(a, b);
		expect(c.farms.map((f) => [f.nodeIdA, f.nodeIdB])).toEqual([
			['a', 'a2'],
			['b', 'b2']
		]);
		for (const f of c.farms) expect(f.demandM3Day.delta).toBe(0);
	});
});
