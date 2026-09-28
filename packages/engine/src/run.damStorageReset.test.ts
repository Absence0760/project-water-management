// settings.damStorageReset (engine 0.46.0, issue #53 R6, docs/model.md
// §2.15a): on one day each listed farm dam starts from a set storage instead
// of the day before's, and the run publishes the step as dam_storage_set so
// every balance still closes. The review triggers set it to start the
// seasonal outlook from a storage band.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from './calendar';
import type { ModelInput, ModelOutput } from './project';
import { Rng } from './random';
import { runModel, runModelChecked } from './run';
import { randomInput } from './testing/fuzz';
import { checkAll } from './testing/invariants';

const N = 30;
const col = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;
const withReset = (input: ModelInput, reset: ModelInput['settings']['damStorageReset']): ModelInput => ({ ...input, settings: { ...input.settings, damStorageReset: reset } });
const dams = (input: ModelInput) => input.model.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);

/** Every series and summary figure but the warnings. */
const body = (out: ModelOutput) => ({ ...out, summary: { ...out.summary, warnings: [] } });

describe('settings.damStorageReset (engine 0.46.0)', () => {
	it('absent, null, or with nothing it can set: the run is the plain run, to the bit', () => {
		for (let seed = 1; seed <= 8; seed++) {
			const base = randomInput(seed, { maxNodes: 8, maxDays: 400 });
			const x = runModel(base);
			expect(runModel(withReset(base, null)), `seed ${seed} null`).toEqual(x);
			expect(runModel(withReset(base, undefined)), `seed ${seed} undefined`).toEqual(x);
			const noDam = base.model.nodes.find((n) => !(n.kind === 'farm' && n.damCapacityM3 > 0))?.id ?? 'nowhere';
			const mid = fromEpochDay(toEpochDay(x.startDate) + Math.floor(x.days / 2));
			// Only a node without a dam listed, a date outside the run, a date that isn't one: warned about, else unchanged.
			for (const [why, r] of [
				['a node without a dam', { date: mid, storageM3: { [noDam]: 5 } }],
				['before the run', { date: '1900-01-01', storageM3: Object.fromEntries(dams(base).map((n) => [n.id, 0])) }],
				['not a date', { date: 'soon', storageM3: {} }]
			] as const) {
				const y = runModel(withReset(base, r));
				expect(body(y), `seed ${seed} ${why}`).toEqual(body(x));
				expect(y.summary.warnings.some((w) => w.startsWith('damStorageReset')), `seed ${seed} ${why}`).toBe(true);
			}
		}
	});

	it(`setting each dam to the storage the run had is the plain run, with a zero step (${N} random networks)`, () => {
		let tried = 0;
		for (let seed = 1; seed <= N; seed++) {
			const base = randomInput(seed, { maxNodes: 10, maxDays: 500 });
			const x = runModel(base);
			const ds = dams(base);
			if (!ds.length || x.days < 3) continue;
			const d = new Rng(seed ^ 0x5e7).int(1, x.days - 1);
			const storageM3 = Object.fromEntries(ds.map((n) => [n.id, col(x, n.id, 'dam_storage')![d - 1]!]));
			const y = runModel(withReset(base, { date: fromEpochDay(toEpochDay(x.startDate) + d), storageM3 }));
			for (const s of x.series) expect(col(y, s.nodeId, s.key), `seed ${seed} ${s.nodeId}/${s.key}`).toEqual(s.values);
			for (const n of ds) expect(col(y, n.id, 'dam_storage_set')!.every((v) => v === 0), `seed ${seed} ${n.id}`).toBe(true);
			expect(y.summary.warnings).toEqual(x.summary.warnings);
			tried++;
		}
		expect(tried).toBeGreaterThan(N / 2);
	}, 300_000);

	it(`any reset leaves the days before it alone and passes every self-check and invariant (${N} random networks)`, () => {
		let tried = 0;
		for (let seed = 1; seed <= N; seed++) {
			const base = randomInput(seed, { maxNodes: 10, maxDays: 500 });
			const x = runModel(base);
			const ds = dams(base);
			if (!ds.length || x.days < 3) continue;
			const g = new Rng(seed ^ 0x7e5e7);
			const d = g.int(0, x.days - 1);
			// Anywhere from empty to full, now and then outside (clamped, with a warning).
			const storageM3 = Object.fromEntries(ds.map((n) => [n.id, n.damCapacityM3 * g.float(-0.1, 1.1)]));
			const input = withReset(base, { date: fromEpochDay(toEpochDay(x.startDate) + d), storageM3 });
			const y = runModel(input);
			for (const s of x.series) expect(col(y, s.nodeId, s.key)!.slice(0, d), `seed ${seed} ${s.nodeId}/${s.key}`).toEqual(s.values.slice(0, d));
			for (const n of ds) {
				const set = col(y, n.id, 'dam_storage_set')!;
				const want = Math.min(Math.max(storageM3[n.id]!, 0), n.damCapacityM3);
				const before = d === 0 ? n.damInitialPct * n.damCapacityM3 : col(x, n.id, 'dam_storage')![d - 1]!;
				expect(set[d], `seed ${seed} ${n.id}`).toBeCloseTo(want - before, 6);
				expect(set.filter((v, t) => t !== d && v !== 0), `seed ${seed} ${n.id}`).toEqual([]);
			}
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
			const checked = runModelChecked(input);
			expect(checked.summary.verification!.checks.filter((c) => !c.passed), `seed ${seed}`).toEqual([]);
			const wb = checked.summary.waterBalance!;
			for (const r of [...wb.years, wb.total]) {
				expect(r.storageSetM3, `seed ${seed}`).toBeDefined();
				expect(Math.abs(r.residualM3), `seed ${seed} ${r.waterYear}`).toBeLessThanOrEqual(1e-6 * Math.max(1, r.openingStorageM3 + r.closingStorageM3 + r.naturalFlowM3 + Math.abs(r.storageSetM3!)));
			}
			expect(y.summary.supplyAssurance!.waterAccount.total.storageSetM3, `seed ${seed}`).toBeCloseTo(
				ds.reduce((a, n) => a + col(y, n.id, 'dam_storage_set')![d]!, 0),
				6
			);
			tried++;
		}
		expect(tried).toBeGreaterThan(N / 2);
	}, 300_000);

	it('warns about a storage outside the dam, a node without a dam, and a value that is not a number', () => {
		const base = randomInput(4, { maxNodes: 6, maxDays: 300 });
		const x = runModel(base);
		const [a] = dams(base);
		expect(a).toBeDefined();
		const date = fromEpochDay(toEpochDay(x.startDate) + 10);
		const over = runModel(withReset(base, { date, storageM3: { [a!.id]: a!.damCapacityM3 * 2 } }));
		expect(over.summary.warnings.some((w) => w.includes('outside 0 … its capacity') && w.includes('clamped'))).toBe(true);
		expect(col(over, a!.id, 'dam_storage_set')![10]).toBeCloseTo(a!.damCapacityM3 - col(x, a!.id, 'dam_storage')![9]!, 6);
		const nan = runModel(withReset(base, { date, storageM3: { [a!.id]: Number.NaN } }));
		expect(nan.summary.warnings.some((w) => w.includes('is not a number'))).toBe(true);
		expect(col(nan, a!.id, 'dam_storage_set')).toBeUndefined();
		const missing = runModel(withReset(base, { date, storageM3: { nowhere: 1 } }));
		expect(missing.summary.warnings).toContain('damStorageReset: "nowhere" is not a farm with a dam; ignored');
	});
});
