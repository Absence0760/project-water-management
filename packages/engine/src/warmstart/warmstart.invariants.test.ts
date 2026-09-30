// Capture and resume on random networks (engine 1.1.0, docs/model.md
// §2.16): every part of the model the generator draws (transfers, dam
// curves and releases, boreholes with annual caps and depletion lags, supply
// rules and the river pump, other water users, land cover, Reserve rule
// tables, CHIRPS, zero runs and accumulations, both runoff models), with
// demand factors from a date and storage resets, resumed at the first day,
// the last, the day after, a 1 October and a 29 February when the run holds
// them, and random days; and with a drought restriction rule (engine 1.52.0). Soak: WARM_CASES=500 pnpm -C packages/engine exec
// vitest run src/warmstart/warmstart.invariants.test.ts (WARM_SEED picks the
// first seed). A 550-seed soak of the same check (3 300 networks up to 1 200
// days, 21 878 captures and resumes) found no difference, 2026-09-26.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { captureModelState, runModelFrom, runModelWithoutChecks } from '../run';
import { randomDroughtRestriction, randomInput, Rng } from '../testing/fuzz';
import { checkResume } from '../testing/warmstartInvariants';
import { withDamStorage } from './snapshot';

const CASES = Number(process.env.WARM_CASES ?? 8);
const FIRST = Number(process.env.WARM_SEED ?? 1);

type Variant = 'plain' | 'demandFactorFrom' | 'damStorageReset' | 'droughtRestriction';

/** A seed's network with a demand factor from a random day (or every day), or a storage reset on a random day. */
function variantInput(seed: number, variant: Variant): { input: ModelInput; full: ModelOutput } | null {
	const input = randomInput(seed, { maxDays: 800 });
	const rng = new Rng(seed * 31 + variant.length);
	let full: ModelOutput;
	try {
		full = runModelWithoutChecks(input);
	} catch {
		return null;
	}
	const s0 = toEpochDay(full.startDate);
	if (variant === 'demandFactorFrom') {
		for (const n of input.model.nodes) if (n.kind !== 'gauge' && rng.bool(0.5)) n.demandFactor = Array.from({ length: 12 }, () => rng.float(0, 2));
		input.settings.demandFactorFrom = rng.bool(0.2) ? null : fromEpochDay(s0 + rng.int(0, full.days - 1));
	} else if (variant === 'damStorageReset') {
		const storageM3: Record<string, number> = {};
		for (const n of input.model.nodes) if (n.kind === 'farm' && n.damCapacityM3 > 0 && rng.bool(0.7)) storageM3[n.id] = rng.float(0, n.damCapacityM3);
		input.settings.damStorageReset = { date: fromEpochDay(s0 + rng.int(0, full.days - 1)), storageM3 };
	} else if (variant === 'droughtRestriction') {
		// The drought restriction rule (engine ≥ 1.52.0): the level held since the last review is part of the state.
		input.settings.droughtRestriction = randomDroughtRestriction(rng, input.model.nodes);
	}
	return { input, full: variant === 'plain' ? full : runModelWithoutChecks(input) };
}

/** The first day, the last, the day after, a 1 October and a 29 February when the run holds them, and two random days. */
function splitDays(full: ModelOutput, rng: Rng): number[] {
	const s0 = toEpochDay(full.startDate);
	const out = new Set([0, full.days - 1, full.days, rng.int(0, full.days), rng.int(0, full.days)]);
	let oct = false;
	let feb = false;
	for (let k = 1; k < full.days && !(oct && feb); k++) {
		const d = fromEpochDay(s0 + k);
		if (!oct && d.endsWith('-10-01')) (oct = true), out.add(k);
		if (!feb && d.endsWith('-02-29')) (feb = true), out.add(k);
	}
	return [...out].sort((a, b) => a - b);
}

describe('capture and resume on random networks', () => {
		for (const variant of ['plain', 'demandFactorFrom', 'damStorageReset', 'droughtRestriction'] as const) {
			it(`${variant}: a resumed run is the uninterrupted run's tail to the bit (${CASES} networks)`, () => {
				const failures: string[] = [];
				let checked = 0;
				for (let seed = FIRST; seed < FIRST + CASES; seed++) {
					const v = variantInput(seed, variant);
					if (!v) continue;
					for (const k of splitDays(v.full, new Rng(seed))) {
						checked++;
						const d = checkResume(v.input, k, v.full);
						if (d) failures.push(`seed ${seed}: ${d}`);
					}
				}
				expect(checked).toBeGreaterThan(CASES * 3);
				expect(failures).toEqual([]);
			});
		}

	it(`withDamStorage on a snapshot is a storage reset on its day, every series but the reset's step (${CASES} networks)`, () => {
		let tested = 0;
		for (let seed = FIRST; seed < FIRST + CASES; seed++) {
			const v = variantInput(seed, 'plain');
			if (!v) continue;
			const dams = v.input.model.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
			// A day inside the run after its first needs two days: on a one-day run rng.int(1, 0) is 1, the day after it.
			if (!dams.length || v.full.days < 2) continue;
			tested++;
			const at = fromEpochDay(toEpochDay(v.full.startDate) + new Rng(seed).int(1, v.full.days - 1));
			const storageM3 = Object.fromEntries(dams.map((n, i) => [n.id, (n.damCapacityM3 * ((seed + i) % 5)) / 4]));
			const snap = captureModelState(v.input, at);
			const reset = runModelFrom(snap, { ...v.input, settings: { ...v.input.settings, damStorageReset: { date: at, storageM3 } } });
			const set = runModelFrom(withDamStorage(snap, v.input, storageM3), v.input);
			expect(set.series.map((s) => s.key)).toEqual(reset.series.filter((s) => s.key !== 'dam_storage_set').map((s) => s.key));
			for (const s of set.series) expect(s.values, `seed ${seed} ${s.nodeId}/${s.key}`).toEqual(reset.series.find((x) => x.nodeId === s.nodeId && x.key === s.key)!.values);
		}
		expect(tested).toBeGreaterThan(0);
	});
});
