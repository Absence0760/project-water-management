// Seasonal outlook invariants on random networks (docs/model.md §2.15):
//  - every level's history is the same: the members of one analogue agree
//    on every series up to the decision date, bit for bit;
//  - a lower demand level never asks for more water over the season;
//  - where demand only takes water out (no irrigation losses returning to
//    the river, no groundwater), a lower demand level never lowers
//    season-end dam storage and never adds a day below the EWR, in any
//    analogue year. With them it can, by design (model.md §2.15 says why:
//    losses of water taken from a dam reach the river on dry days, and an
//    emergency or drought borehole tops up a dam that a higher demand ran
//    low), so the random networks keep them for the first two properties
//    and drop them for the third.
// Soak: OUTLOOK_FUZZ_CASES=500 pnpm -C packages/engine exec vitest run src/outlook/outlook.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput } from '../project';
import { Rng } from '../random';
import { runModelWithoutChecks } from '../run';
import type { ScenarioOp } from '../scenario/ops';
import { randomInput } from '../testing/fuzz';
import { outlookAnalogues, outlookMember, outlookMemberInput } from './outlook';
import type { OutlookSeason } from './season';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.OUTLOOK_FUZZ_CASES ?? 40);
const SEED0 = Number(env.FUZZ_SEED ?? 1);
const FACTORS = [1.3, 1, 0.7, 0.3, 0];

const ops = (input: ModelInput, factor: number): ScenarioOp[] =>
	(['farm', 'user'] as const).filter((c) => input.model.nodes.some((n) => n.kind === c)).map((category) => ({ op: 'demand.scale', factor, category }));

/** No irrigation losses back to the river, no user returns, no groundwater: demand only takes water out. */
function withoutReturns(x: ModelInput): ModelInput {
	return {
		...x,
		model: {
			...x.model,
			boreholes: [],
			nodes: x.model.nodes.map((n) => ({ ...n, returnFlowFraction: 0, userReturnPct: 0, boreholeCapacityM3Day: null }))
		}
	};
}

interface Case {
	input: ModelInput;
	season: OutlookSeason;
}

/** A random network whose record holds a season of 30–200 days after at least 200 days of history, and an analogue. */
function caseFor(seed: number, strip: boolean): Case | null {
	let input = randomInput(seed, { maxNodes: 10, maxDays: 1200 });
	if (strip) input = withoutReturns(input);
	const base = runModelWithoutChecks(input);
	const g = new Rng(seed ^ 0x0e5b);
	const len = g.int(30, 200);
	if (base.days < 200 + 2 * len) return null;
	const d = toEpochDay(base.startDate) + g.int(200, base.days - len);
	return { input, season: { decisionDate: fromEpochDay(d), seasonEnd: fromEpochDay(d + len - 1) } };
}

function check(c: Case, seed: number, plain: boolean): number {
	const base = runModelWithoutChecks(c.input);
	const { analogues } = outlookAnalogues(base, c.season);
	const i0 = toEpochDay(c.season.decisionDate) - toEpochDay(base.startDate);
	let compared = 0;
	for (const a of analogues) {
		const runs = FACTORS.map((f) => {
			const m = outlookMemberInput(c.input, base, c.season, a, ops(c.input, f));
			expect(m.problems, `seed ${seed}`).toEqual([]);
			const out = runModelWithoutChecks(m.input);
			return { out, member: outlookMember(out, m.input.model, c.season, a) };
		});
		for (const x of runs[0]!.out.series) {
			for (const r of runs.slice(1)) expect(r.out.series.find((y) => y.nodeId === x.nodeId && y.key === x.key)!.values.slice(0, i0), `seed ${seed} ${a.label} ${x.nodeId}/${x.key}`).toEqual(x.values.slice(0, i0));
		}
		for (let k = 1; k < runs.length; k++) {
			const [hi, lo] = [runs[k - 1]!.member, runs[k]!.member];
			const where = `seed ${seed} ${a.label}: ${FACTORS[k - 1]} → ${FACTORS[k]}`;
			const more = (a: number, b: number) => a - b > 1e-9 * Math.max(1, Math.abs(b));
			expect(more(lo.demandM3 + lo.userDemandM3, hi.demandM3 + hi.userDemandM3), `${where} demand`).toBe(false);
			compared++;
			if (!plain) continue;
			if (hi.seasonEndStorageM3 !== null) expect(lo.seasonEndStorageM3!, `${where} storage`).toBeGreaterThanOrEqual(hi.seasonEndStorageM3 - 1e-6 * Math.max(1, hi.seasonEndStorageM3));
			expect(lo.ewrDays.below, `${where} days below the EWR`).toBeLessThanOrEqual(hi.ewrDays.below);
		}
	}
	return compared;
}

describe('seasonal outlook on random networks', () => {
	it(`every level shares the history, and a lower level never asks for more (${CASES} networks)`, () => {
		let compared = 0;
		for (let seed = SEED0; seed < SEED0 + CASES; seed++) {
			const c = caseFor(seed, false);
			if (c) compared += check(c, seed, false);
		}
		expect(compared).toBeGreaterThan(CASES);
	}, 300_000);

	it(`where demand only takes water out, a lower level never lowers season-end storage or adds a day below the EWR (${CASES} networks)`, () => {
		let compared = 0;
		for (let seed = SEED0; seed < SEED0 + CASES; seed++) {
			const c = caseFor(seed, true);
			if (c) compared += check(c, seed, true);
		}
		expect(compared).toBeGreaterThan(CASES);
	}, 300_000);
});
