// settings.demandFactorFrom (engine 0.44.0, issue #53 R5, docs/model.md
// §2.15): the nodes' demand factors apply from that day; before it every
// factor is 1. The seasonal outlook sets it so a demand level changes the
// season, not the history the season starts from.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay } from './calendar';
import type { ModelInput, ModelOutput } from './project';
import { runModel, runModelChecked } from './run';
import { applyScenario } from './scenario/overrides';
import type { ScenarioOp } from './scenario/ops';
import { randomInput } from './testing/fuzz';
import { checkAll, floorLift } from './testing/invariants';
import { Rng } from './random';

const N = 30;
const col = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;
const everyone = (input: ModelInput, factor: number): ScenarioOp[] =>
	(['farm', 'user'] as const).filter((c) => input.model.nodes.some((n) => n.kind === c)).map((category) => ({ op: 'demand.scale', factor, category }));

describe('settings.demandFactorFrom (engine 0.44.0)', () => {
	it(`leaves every series before the day as the base's to the bit and scales demand from it, on ${N} random networks`, () => {
		let scaledDays = 0;
		for (let seed = 1; seed <= N; seed++) {
			const base = randomInput(seed, { maxNodes: 10, maxDays: 500, allocationModes: false });
			const x = runModel(base);
			if (x.days < 3) continue;
			const g = new Rng(seed ^ 0x51ed27);
			const cut = g.int(1, x.days - 1);
			const from = fromEpochDay(toEpochDay(x.startDate) + cut);
			const factor = g.float(0, 2);
			const r = applyScenario({ ...base, settings: { ...base.settings, demandFactorFrom: from } }, everyone(base, factor));
			expect(r.problems).toEqual([]);
			const y = runModel(r.input);
			expect(y.days).toBe(x.days);
			// Nothing before the day depends on the factor: the model is causal in demand.
			for (const s of x.series) {
				const v = col(y, s.nodeId, s.key);
				expect(v?.slice(0, cut), `seed ${seed} ${s.nodeId}/${s.key}`).toEqual(s.values.slice(0, cut));
			}
			for (const n of base.model.nodes) {
				if (n.kind === 'gauge') continue;
				const [D0, D] = [col(x, n.id, 'demand')!, col(y, n.id, 'demand')!];
				// The basic-needs floor (engine ≥ 1.44.0): exactly factor × the base's demand plus what the
				// floor holds on a cut (factor < 1), worked from the model (floorLift); nothing more.
				for (let t = cut; t < D.length; t++) {
					const want = factor * D0[t]! + floorLift(base, x, n.id, t, factor);
					expect(Math.abs(D[t]! - want), `seed ${seed} ${n.id} day ${t}`).toBeLessThanOrEqual(1e-9 * Math.max(1, D0[t]!));
					if (D0[t]! > 0) scaledDays++;
				}
			}
			expect(checkAll(r.input, seed), `seed ${seed}`).toBeNull();
		}
		expect(scaledDays).toBeGreaterThan(N);
	}, 300_000);

	it('passes the self-checks (the crop-requirement working reads the factor from the day)', () => {
		const base = randomInput(3, { maxNodes: 6, maxDays: 400, allocationModes: false });
		const x = runModel(base);
		const from = fromEpochDay(toEpochDay(x.startDate) + Math.floor(x.days / 2));
		const r = applyScenario({ ...base, settings: { ...base.settings, demandFactorFrom: from } }, everyone(base, 0.5));
		const out = runModelChecked(r.input);
		expect(out.summary.verification!.checks.filter((c) => !c.passed)).toEqual([]);
	});

	it('before the run means every day, after it no day; absent or null is every day', () => {
		const base = randomInput(5, { maxNodes: 6, maxDays: 300, allocationModes: false });
		const scaled = applyScenario(base, everyone(base, 0.5)).input;
		const every = runModel(scaled);
		const before = runModel({ ...scaled, settings: { ...scaled.settings, demandFactorFrom: '1900-01-01' } });
		const nulled = runModel({ ...scaled, settings: { ...scaled.settings, demandFactorFrom: null } });
		const after = runModel({ ...scaled, settings: { ...scaled.settings, demandFactorFrom: '2999-01-01' } });
		expect(before.series).toEqual(every.series);
		expect(nulled.series).toEqual(every.series);
		expect(after.series).toEqual(runModel(base).series);
	});

	it('ignores a value that is not an ISO date, with a warning', () => {
		const base = randomInput(9, { maxNodes: 6, maxDays: 300, allocationModes: false });
		const scaled = applyScenario(base, everyone(base, 0.5)).input;
		const out = runModel({ ...scaled, settings: { ...scaled.settings, demandFactorFrom: '1 Oct' } });
		expect(out.series).toEqual(runModel(scaled).series);
		expect(out.summary.warnings).toContain('demandFactorFrom "1 Oct" is not an ISO date (YYYY-MM-DD); demand factors apply on every day');
	});

	it('scales month by month from the day (a months-form op)', () => {
		const base = randomInput(11, { maxNodes: 6, maxDays: 500, allocationModes: false });
		const x = runModel(base);
		const cut = Math.floor(x.days / 3);
		const day0 = toEpochDay(x.startDate);
		const ops: ScenarioOp[] = base.model.nodes.some((n) => n.kind === 'farm') ? [{ op: 'demand.scale', factor: 0.25, months: [1, 2, 12] }] : [];
		const y = runModel(applyScenario({ ...base, settings: { ...base.settings, demandFactorFrom: fromEpochDay(day0 + cut) } }, ops).input);
		for (const n of base.model.nodes) {
			if (n.kind !== 'farm') continue;
			const [D0, D] = [col(x, n.id, 'demand')!, col(y, n.id, 'demand')!];
			for (let t = 0; t < D.length; t++) {
				const k = t >= cut && [1, 2, 12].includes(monthOfEpochDay(day0 + t)) ? 0.25 : 1;
				expect(Math.abs(D[t]! - k * D0[t]!)).toBeLessThanOrEqual(1e-9 * Math.max(1, D0[t]!));
			}
		}
	});
});
