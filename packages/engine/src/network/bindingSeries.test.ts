// The stored binding EWR site (engine ≥ 1.5.0): which farms get the series,
// what it holds, and that the per-run self-check catches a wrong one.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { checkEwrAttribution } from '../testing/invariants';
import { bindingFromCharge, EWR_BINDING_SERIES } from './bindingSeries';
import { buildTopology, ewrSiteNodes } from './topology';

/** Per farm, how many EWR sites its outflow reaches. */
function sitesAboveCount(input: ModelInput): Map<string, number> {
	const nodes = input.model.nodes;
	const topo = buildTopology(nodes);
	const count = new Map<string, number>();
	for (const site of ewrSiteNodes(nodes, topo.outflow)) {
		const stack = [site];
		const seen = new Set<number>();
		while (stack.length) {
			const i = stack.pop()!;
			if (seen.has(i)) continue;
			seen.add(i);
			if (nodes[i]!.kind === 'farm') count.set(nodes[i]!.id, (count.get(nodes[i]!.id) ?? 0) + 1);
			stack.push(...topo.upstream[i]!);
		}
	}
	return count;
}

function cases(count: number): { input: ModelInput; out: ModelOutput }[] {
	const out: { input: ModelInput; out: ModelOutput }[] = [];
	for (let seed = 1; out.length < count && seed < 400; seed++) {
		const input = randomInput(seed, { maxDays: 300 });
		try {
			const run = runModel(input);
			if (run.series.some((s) => s.key === EWR_BINDING_SERIES.key && s.values.some(Number.isFinite))) out.push({ input, out: run });
		} catch {
			continue;
		}
	}
	return out;
}

describe('the stored binding site', () => {
	const runs = cases(10);

	it('is stored for every farm upstream of two or more EWR sites, and only for those', () => {
		expect(runs).toHaveLength(10);
		for (const { input, out } of runs) {
			const above = sitesAboveCount(input);
			for (const n of input.model.nodes) {
				const stored = out.series.some((s) => s.nodeId === n.id && s.key === EWR_BINDING_SERIES.key);
				expect(stored, n.id).toBe(n.kind === 'farm' && (above.get(n.id) ?? 0) >= 2);
			}
		}
	});

	it('names a site exactly on the days the farm is charged (NaN otherwise)', () => {
		for (const { out } of runs) {
			const sites = out.summary.curtailment!.ewrSites!.length;
			for (const s of out.series.filter((x) => x.key === EWR_BINDING_SERIES.key)) {
				const charge = out.series.find((x) => x.nodeId === s.nodeId && x.key === 'ewr_charge')!.values;
				s.values.forEach((v, t) => {
					if (charge[t]! < 0) expect(Number.isInteger(v) && v >= 0 && v < sites).toBe(true);
					else expect(v).toBeNaN();
				});
			}
		}
	});

	it('a wrong site or a missing one fails the run’s attribution self-check', () => {
		const { input, out } = runs[0]!;
		expect(checkEwrAttribution(input, out)).toBeNull();
		const s = out.series.find((x) => x.key === EWR_BINDING_SERIES.key && x.values.some(Number.isFinite))!;
		const t = s.values.findIndex(Number.isFinite);
		const bad = (value: number) => ({ ...out, series: out.series.map((x) => (x === s ? { ...x, values: x.values.map((v, i) => (i === t ? value : v)) } : x)) });
		expect(checkEwrAttribution(input, bad(NaN))).toMatch(/no binding site stored/);
		expect(checkEwrAttribution(input, bad(99))).toMatch(/is not an EWR site below it/);
	});

	it('follows from the charge for a farm upstream of one site, and can’t for two', () => {
		expect(Array.from(bindingFromCharge([0, -2, 0, -1], [3])!)).toEqual([-1, 3, -1, 3]);
		expect(Array.from(bindingFromCharge([0, 0], [])!)).toEqual([-1, -1]);
		expect(bindingFromCharge([-1], [0, 1])).toBeNull();
	});
});
