// A transfer out of the catchment (engine 1.86.0, issue #523 B5, docs/model.md
// §2.6): a dam rule with no destination unit (toNodeId null). It runs as any
// dam rule (its months, rates, priority and the source dam's reserve) but the
// water leaves the model, counted as water leaving the catchment in the water
// balance and the water account. Hand examples.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { ModelInput, NetworkNode, RunSeries, Transfer } from './project';
import { runModel, runModelWith, withVerification } from './run';
import { checkInvariants, checkTransferLimits } from './verify/checks';
import { modelRuleProblems } from './modelRules';
import { randomInput } from './testing/fuzz';
import { checkAll } from './testing/invariants';

const flat = (v: number) => new Array(12).fill(v);

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** A dam rule from S of `m3Day` a day, all year; out of the catchment unless `toNodeId` says otherwise. */
const rule = (over: Partial<Transfer> = {}, m3Day = 100): Transfer => ({
	id: 'x1',
	fromNodeId: 'S',
	toNodeId: null,
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: m3Day / 86_400,
	dailyCapM3: m3Day,
	minStoragePct: 0.5,
	enabled: true,
	priority: 0,
	...over
});

// S: a full 1000 m³ dam, no demand, all the runoff. C: an empty 1000 m³ dam with no demand, the internal
// destination when a test needs one. G: the outlet gauge. No A-pan, so the dams neither evaporate nor seep.
function model(transfers: Transfer[], days = 10): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly },
		model: {
			nodes: [
				node('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 9 }),
				node('S', { areaKm2: 1, sortOrder: 1, damCapacityM3: 1000, damInitialPct: 1, pctRunoffToDam: 1 }),
				node('C', { sortOrder: 2, damCapacityM3: 1000 })
			],
			crops: [],
			cropAreas: [],
			transfers
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (input: ModelInput, natural?: number[]) =>
	withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural ?? new Array(input.series.rain_catchment_mm!.values.length).fill(0) })));
function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
function passes(input: ModelInput, out: ReturnType<typeof run>) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
}

describe('a transfer out of the catchment (engine 1.86.0)', () => {
	it('moves water only while the source dam is above its minimum storage', () => {
		const input = model([rule()]);
		const out = run(input);
		// 1000 m³ full, 500 kept: five days of 100 m³, then nothing.
		expect(get(out, 'S', 'transfer_rule@x1')).toEqual([100, 100, 100, 100, 100, 0, 0, 0, 0, 0]);
		expect(get(out, 'S', 'transfer')).toEqual([-100, -100, -100, -100, -100, 0, 0, 0, 0, 0]);
		expect(Math.min(...get(out, 'S', 'dam_storage'))).toBe(500);
		// The water never reaches a unit or the river.
		expect(get(out, 'C', 'transfer').every((v) => v === 0)).toBe(true);
		expect(get(out, null, 'simulated_outflow').every((v) => v === 0)).toBe(true);
		expect(out.series.find((s) => s.key === 'transfer_rule@x1')!.label).toBe('Transferred out of the catchment by one transfer rule');
		passes(input, out);
	});

	it('the dam’s minimum operating level holds it back too, whichever is higher', () => {
		const input = model([rule({ minStoragePct: 0 })]);
		input.model.nodes[1]!.damMinPct = 0.8;
		const out = run(input);
		expect(get(out, 'S', 'transfer_rule@x1')).toEqual([100, 100, 0, 0, 0, 0, 0, 0, 0, 0]);
		passes(input, out);
	});

	it('runs in its months only', () => {
		// January is the only month off; the run starts 1 January and the rule is idle until 1 February.
		const input = model([rule({ months: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] })], 40);
		const out = run(input);
		const v = get(out, 'S', 'transfer_rule@x1');
		expect(v.slice(0, 31).every((x) => x === 0)).toBe(true);
		expect(v.slice(31, 36)).toEqual([100, 100, 100, 100, 100]);
		passes(input, out);
	});

	it('closes the water balance and the water account, with what left the catchment as its own out term', () => {
		const input = model([rule()]);
		const out = run(input);
		const wb = out.summary.waterBalance!.total;
		expect(wb.externalTransferM3).toBeCloseTo(500, 9);
		// Between units nothing moved; the farms' own sum of J is −500.
		expect(wb.transfersM3).toBeCloseTo(0, 9);
		expect(wb.openingStorageM3 - wb.closingStorageM3).toBeCloseTo(500, 9);
		expect(Math.abs(wb.residualM3)).toBeLessThan(1e-9);
		const acc = out.summary.supplyAssurance!.waterAccount.total;
		expect(acc.externalTransferM3).toBeCloseTo(500, 9);
		expect(acc.transfersM3).toBeCloseTo(0, 9);
		expect(Math.abs(acc.residualM3)).toBeLessThan(1e-9);
		for (const y of out.summary.supplyAssurance!.waterAccount.years) expect(Math.abs(y.residualM3)).toBeLessThan(1e-9);
		passes(input, out);
	});

	it('shares the source dam pro rata with the other rules of its priority', () => {
		// 1000 m³, reserve 80 %: 200 m³ free on day 0. The external rule asks 100, the rule into C 300:
		// 400 asked of 200, so each gets half of what it asks (50 and 150), whatever the list order.
		for (const order of [0, 1]) {
			const rules = [rule({ minStoragePct: 0.8 }), rule({ id: 'x2', toNodeId: 'C', minStoragePct: 0.8 }, 300)];
			const input = model(order ? rules.reverse() : rules, 2);
			const out = run(input);
			expect(get(out, 'S', 'transfer_rule@x1')[0]).toBeCloseTo(50, 9);
			expect(get(out, 'S', 'transfer_rule@x2')[0]).toBeCloseTo(150, 9);
			expect(get(out, 'C', 'transfer')[0]).toBeCloseTo(150, 9);
			// Nothing free on day 1.
			expect(get(out, 'S', 'transfer')[1]).toBe(0);
			expect(out.summary.waterBalance!.total.externalTransferM3).toBeCloseTo(50, 9);
			passes(input, out);
		}
	});

	it('moves first or last by its priority', () => {
		// Priority 0 first: the external rule takes its 100 of the 200 free, the rule into C the other 100.
		const first = model([rule({ minStoragePct: 0.8 }), rule({ id: 'x2', toNodeId: 'C', minStoragePct: 0.8, priority: 1 }, 300)], 1);
		const a = run(first);
		expect(get(a, 'S', 'transfer_rule@x1')).toEqual([100]);
		expect(get(a, 'S', 'transfer_rule@x2')).toEqual([100]);
		passes(first, a);
		const last = model([rule({ minStoragePct: 0.8, priority: 2 }), rule({ id: 'x2', toNodeId: 'C', minStoragePct: 0.8, priority: 1 }, 300)], 1);
		const b = run(last);
		expect(get(b, 'S', 'transfer_rule@x1')).toEqual([0]);
		expect(get(b, 'S', 'transfer_rule@x2')).toEqual([200]);
		passes(last, b);
	});

	it('is off unless set: a switched-off rule leaves the run as it was, with no external term', () => {
		const none = run(model([]));
		const off = run(model([rule({ enabled: false })]));
		expect(off.series).toEqual(none.series);
		expect(off.summary.waterBalance).toEqual(none.summary.waterBalance);
		expect(off.summary.supplyAssurance?.waterAccount).toEqual(none.summary.supplyAssurance?.waterAccount);
		expect('externalTransferM3' in none.summary.waterBalance!.total).toBe(false);
		expect('externalTransferM3' in none.summary.supplyAssurance!.waterAccount.total).toBe(false);
	});

	it('the transfer limits check catches one that drew below its reserve or past its limit', () => {
		const input = model([rule()]);
		const out = run(input);
		const edit = (nodeId: string, key: string, f: (v: number[]) => void) => {
			const x = structuredClone(out);
			f(x.series.find((s) => s.nodeId === nodeId && s.key === key)!.values);
			return x;
		};
		expect(checkTransferLimits(input, out)).toBeNull();
		// Sent 600 on day 5 from a dam at its reserve.
		expect(checkTransferLimits(input, edit('S', 'transfer', (v) => (v[5] = -100)))).toMatch(/sent/);
		// A rule volume that doesn't add up to the source's transfer.
		expect(checkInvariants(input, edit('S', 'transfer_rule@x1', (v) => (v[0] = 40)))).not.toBeNull();
	});

	it('save rules: a dam rule may leave the catchment, a river off-take may not', () => {
		const ok = model([rule()]);
		expect(modelRuleProblems(ok.model)).toEqual([]);
		const river = model([rule({ source: 'river' })]);
		expect(modelRuleProblems(river.model).join('\n')).toMatch(/can't send water out of the catchment/);
	});

	it('random networks: every invariant holds with dam rules sent out of the catchment, and the balances close', () => {
		// The random networks (./testing/fuzz.ts) with each seed's dam rules from a farm sent out of the catchment
		// instead (the generator itself is unchanged, so the pinned seeds keep their networks).
		let moved = 0;
		let tried = 0;
		for (let seed = 1; tried < 12 && seed < 200; seed++) {
			const input = randomInput(seed);
			const farms = new Set(input.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id));
			const rules = input.model.transfers.filter((t) => t.enabled && t.source !== 'river' && farms.has(t.fromNodeId));
			if (!rules.length) continue;
			tried++;
			for (const t of rules.filter((_, k) => k % 2 === 0)) t.toNodeId = null;
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
			const out = withVerification(input, runModel(input));
			const acc = out.summary.supplyAssurance!.waterAccount.total;
			expect(Math.abs(acc.residualM3), `seed ${seed}`).toBeLessThanOrEqual(1e-9 * Math.max(acc.scaleM3, 1));
			const wb = out.summary.waterBalance!.total;
			// A rule that can never move water (no rate in any month) has no series and adds no term.
			expect(wb.externalTransferM3 ?? 0, `seed ${seed}`).toBeGreaterThanOrEqual(0);
			expect(Math.abs(wb.residualM3), `seed ${seed}`).toBeLessThanOrEqual(1e-6 * Math.max(1, wb.openingStorageM3 + wb.farmRunoffM3));
			if ((wb.externalTransferM3 ?? 0) > 0) moved++;
		}
		expect(tried).toBe(12);
		expect(moved).toBeGreaterThan(3);
	});
});
