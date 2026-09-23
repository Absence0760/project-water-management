// Property-based checks of the engine: random valid inputs (./testing/fuzz.ts)
// must satisfy the b023 balance identities every day at every node. On a
// failure the seed and a shrunk reproduction are printed. Soak run:
//   FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/run.invariants.test.ts
import { describe, expect, it } from 'vitest';
import { calibrationStats } from './network/stats';
import { excelRound } from './network/round';
import { runModel } from './run';
import type { ModelInput, ModelOutput } from './project';
import { randomInput, shrink } from './testing/fuzz';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.FUZZ_CASES ?? 400);
const SEED0 = Number(env.FUZZ_SEED ?? 1);

/** Returns the first broken invariant as text, or null. */
export function checkInvariants(input: ModelInput, out: ModelOutput): string | null {
	const get = new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));
	const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);
	for (const s of out.series) {
		if (s.key === 'observed_flow') continue;
		for (let t = 0; t < s.values.length; t++) {
			if (!Number.isFinite(s.values[t]!)) return `${s.nodeId}/${s.key}[${t}] is ${s.values[t]}`;
		}
	}
	const nodes = input.model.nodes;
	const outlet = nodes.find((n) => n.downstreamNodeId === null)!;
	let totIn = 0;
	let totOut = 0;
	for (const n of nodes) {
		const ups = nodes.filter((u) => u.downstreamNodeId === n.id);
		const U = get.get(`${n.id}|outflow`)!;
		for (let t = 0; t < out.days; t++) {
			const H = ups.reduce((s, u) => s + get.get(`${u.id}|outflow`)![t]!, 0);
			if (Math.abs((n.kind === 'gauge' ? U[t]! : get.get(`${n.id}|inflow_upstream`)![t]!) - H) > tol(H))
				return `${n.id} day ${t}: routed inflow ${H} ≠ upstream sum`;
		}
		if (n.kind === 'gauge') continue;
		const g = (k: string) => get.get(`${n.id}|${k}`)!;
		const [F, G, W, H, I, J, Q, R, AA, Z] = ['demand', 'supplied', 'deficit', 'inflow_upstream', 'runoff', 'transfer', 'dam_storage', 'spill', 'ewr_shortfall', 'ewr_cumulative'].map(g) as number[][];
		const cap = excelRound(n.damCapacityM3, 0);
		let qPrev = excelRound(n.damInitialPct * cap, 0);
		totIn += qPrev;
		for (let t = 0; t < out.days; t++) {
			const T = excelRound(G![t]! * n.returnFlowPct, 0);
			const lhs = H![t]! + I![t]! + J![t]! + qPrev;
			const rhs = U[t]! + G![t]! - T + Q![t]!;
			const where = `${n.id} day ${t}`;
			if (Math.abs(lhs - rhs) > tol(lhs)) return `${where}: farm balance ${lhs} ≠ ${rhs}`;
			if (Q![t]! < -1e-9 || Q![t]! > cap + 1e-9) return `${where}: storage ${Q![t]} outside [0, ${cap}]`;
			if (R![t]! < 0 || (R![t]! > 0 && Math.abs(Q![t]! - cap) > 1e-9)) return `${where}: spill ${R![t]} with storage ${Q![t]}/${cap}`;
			if (G![t]! > F![t]! + 1e-9) return `${where}: supplied ${G![t]} > demand ${F![t]}`;
			if (G![t]! < -1e-9) return `${where}: supplied ${G![t]} < 0`;
			if (Math.abs(W![t]! - (F![t]! - G![t]!)) > 1e-9) return `${where}: deficit ≠ demand − supplied`;
			if (AA![t]! > 0 || Math.abs(AA![t]! - Math.min(U[t]! - Z![t]!, 0)) > tol(U[t]!)) return `${where}: EWR shortfall ${AA![t]}`;
			totIn += I![t]!;
			totOut += G![t]! - T;
			qPrev = Q![t]!;
		}
		totOut += qPrev;
	}
	// Catchment: runoff + opening storage = outflow + consumptive use + closing storage (transfers cancel).
	const sim = get.get('null|simulated_outflow')!;
	const outletU = get.get(`${outlet.id}|outflow`)!;
	for (let t = 0; t < out.days; t++) {
		if (sim[t] !== outletU[t]) return `day ${t}: simulated outflow ≠ outlet node outflow`;
		totOut += sim[t]!;
		const Jsum = nodes.filter((n) => n.kind === 'farm').reduce((s, n) => s + get.get(`${n.id}|transfer`)![t]!, 0);
		if (Math.abs(Jsum) > 1e-6) return `day ${t}: transfers do not net to 0 (${Jsum})`;
		const e = get.get('null|ewr')![t]!;
		const sh = get.get('null|ewr_shortfall')![t]!;
		if (sh !== Math.min(sim[t]! - e, 0) && !(sh === 0 && sim[t]! - e >= 0)) return `day ${t}: catchment EWR shortfall ${sh}`;
	}
	if (Math.abs(totIn - totOut) > 1e-6 * Math.max(1, totIn)) return `catchment mass balance: in ${totIn} ≠ out ${totOut}`;
	return null;
}

function runCase(input: ModelInput): string | null {
	let out: ModelOutput;
	try {
		out = runModel(input);
	} catch (e) {
		return `threw: ${(e as Error).message}`;
	}
	const bad = checkInvariants(input, out);
	if (bad) return bad;
	const again = runModel(input);
	if (JSON.stringify(again) !== JSON.stringify(out)) return 'not deterministic';
	return null;
}

describe('engine invariants on random networks', () => {
	it(`${CASES} random cases from seed ${SEED0}`, () => {
		const failures: string[] = [];
		for (let seed = SEED0; seed < SEED0 + CASES && failures.length < 3; seed++) {
			const input = randomInput(seed);
			const bad = runCase(input);
			if (!bad) continue;
			const rule = bad.split(':')[0]!.replace(/n\d+ day \d+|day \d+/, '');
			const small = shrink(input, (x) => {
				const b = runCase(x);
				return b !== null && b.split(':')[0]!.replace(/n\d+ day \d+|day \d+/, '') === rule;
			});
			failures.push(`seed ${seed}: ${bad}\n  shrunk: ${runCase(small)}\n  repro: ${JSON.stringify(small)}`);
		}
		expect(failures.join('\n\n')).toBe('');
	}, 120_000);
});

describe('calibration statistic identities', () => {
	it('NSE, PBIAS, KGE of a perfect fit and NSE of the mean', () => {
		for (let seed = 1; seed <= 50; seed++) {
			const obs = randomInput(seed).series.flow_observed_m3s?.values ?? [1, 2, 3, null, 5];
			const vals = obs.filter((v): v is number => v !== null);
			if (vals.length < 2 || new Set(vals).size < 2) continue;
			const perfect = calibrationStats(obs.map((o) => (o ?? 0) * 86_400), obs);
			expect(perfect.nse).toBeCloseTo(1, 9);
			expect(perfect.pbias).toBeCloseTo(0, 9);
			expect(perfect.kge).toBeCloseTo(1, 9);
			const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
			expect(calibrationStats(obs.map(() => mean * 86_400), obs).nse).toBeCloseTo(0, 9);
		}
	});
});
