// Review-trigger invariants on random networks (docs/model.md §2.15a): a
// fuller start on the review date never adds a day below the EWR, in any
// analogue year at any demand level, so a level's years met never fall as
// the band fills and a fuller band never picks a lower level than an
// emptier one. Checked where demand only takes water out (no irrigation
// losses returning to the river, no user returns, no groundwater: the R5
// invariants' reduced networks, outlook.invariants.test.ts says why) and,
// since every mechanism that could break it points the same way for
// storage (model.md §2.15a), on the full networks too.
// Soak: TRIGGER_FUZZ_CASES=500 pnpm -C packages/engine exec vitest run src/outlook/triggers.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput } from '../project';
import { Rng } from '../random';
import { runModelWithoutChecks } from '../run';
import type { ScenarioOp } from '../scenario/ops';
import { randomInput } from '../testing/fuzz';
import { outlookAnalogues, outlookMember, outlookMemberInput } from './outlook';
import type { OutlookSeason } from './season';
import { bandStartStorage, storageBands } from './triggers';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.TRIGGER_FUZZ_CASES ?? 40);
const SEED0 = Number(env.FUZZ_SEED ?? 1);
// Highest demand first, as the planning figure ranks them.
const FACTORS = [1.3, 1, 0.7, 0.3, 0];
const SHARE = 0.5;

const ops = (input: ModelInput, factor: number): ScenarioOp[] =>
	(['farm', 'user'] as const).filter((c) => input.model.nodes.some((n) => n.kind === c)).map((category) => ({ op: 'demand.scale', factor, category }));

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

function check(strip: boolean): number {
	let compared = 0;
	for (let seed = SEED0; seed < SEED0 + CASES; seed++) {
		const raw = randomInput(seed, { maxNodes: 10, maxDays: 1200 });
		const input = strip ? withoutReturns(raw) : raw;
		const dams = input.model.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
		if (!dams.length) continue;
		const base = runModelWithoutChecks(input);
		const g = new Rng(seed ^ 0x7219);
		const len = g.int(30, 200);
		if (base.days < 200 + 2 * len) continue;
		const d = toEpochDay(base.startDate) + g.int(200, base.days - len);
		const season: OutlookSeason = { decisionDate: fromEpochDay(d), seasonEnd: fromEpochDay(d + len - 1) };
		const { analogues } = outlookAnalogues(base, season);
		if (!analogues.length) continue;
		const cap = dams.reduce((a, n) => a + n.damCapacityM3, 0);
		// Bands from empty to full, and a band of full dams.
		const { bands } = storageBands([cap / 3, (2 * cap) / 3, cap], cap);
		// Per band (emptiest first), per level, per analogue: days below the EWR.
		const below = bands.map((band) => {
			const start = bandStartStorage(input, band);
			return FACTORS.map((f) =>
				analogues.map((a) => {
					const m = outlookMemberInput(input, base, season, a, ops(input, f), { storageM3: start.storageM3ByDam });
					expect(m.problems, `seed ${seed}`).toEqual([]);
					return outlookMember(runModelWithoutChecks(m.input), m.input.model, season, a).ewrDays.below;
				})
			);
		});
		const pick = (b: number) => {
			const k = below[b]!.findIndex((years) => years.filter((x) => x === 0).length >= SHARE * years.length);
			return k < 0 ? FACTORS.length : k;
		};
		for (let b = 1; b < bands.length; b++) {
			for (let k = 0; k < FACTORS.length; k++) {
				for (let y = 0; y < analogues.length; y++) {
					expect(below[b]![k]![y]!, `seed ${seed} ${analogues[y]!.label} factor ${FACTORS[k]}: band from ${bands[b]!.fromM3} vs ${bands[b - 1]!.fromM3}`).toBeLessThanOrEqual(below[b - 1]![k]![y]!);
					compared++;
				}
			}
			expect(pick(b), `seed ${seed}: band from ${bands[b]!.fromM3} picked a lower level than the band below it`).toBeLessThanOrEqual(pick(b - 1));
		}
	}
	return compared;
}

describe('review triggers on random networks', () => {
	it(`where demand only takes water out, a fuller band never adds a day below the EWR, nor picks a lower level (${CASES} networks)`, () => {
		expect(check(true)).toBeGreaterThan(CASES);
	}, 300_000);

	it(`the same with return flows and groundwater (${CASES} networks)`, () => {
		expect(check(false)).toBeGreaterThan(CASES);
	}, 300_000);
});
