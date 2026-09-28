// Each transfer rule's stored daily volume (engine ≥ 1.6.0): which rules get
// the series, what it holds, and that it makes the per-run attribution
// self-check exact at an EWR site a transfer crosses, with a positive control
// there (a perturbed charge is caught) and the older-run fallback kept.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { checkEwrAttribution } from '../testing/invariants';
import { EWR_BINDING_SERIES } from './bindingSeries';
import { buildTopology, ewrSiteNodes } from './topology';
import { canMove, farmRules, parseTransferRuleKey, readRuleVolumes, transferRuleKey } from './transferSeries';
import { isRiverOfftake } from './offtake';

const find = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key);

/** The node ids upstream of (and including) each EWR site, in the engine's site order. */
function siteCatchments(input: ModelInput): Set<string>[] {
	const nodes = input.model.nodes;
	const topo = buildTopology(nodes);
	return ewrSiteNodes(nodes, topo.outflow).map((site) => {
		const seen = new Set<string>();
		const stack = [site];
		while (stack.length) {
			const i = stack.pop()!;
			if (seen.has(nodes[i]!.id)) continue;
			seen.add(nodes[i]!.id);
			stack.push(...topo.upstream[i]!);
		}
		return seen;
	});
}

interface Crossed {
	input: ModelInput;
	out: ModelOutput;
	/** A farm whose charge a crossed site set on day t. */
	farm: string;
	t: number;
}

/** Seeded runs where a rule that moved water crosses an EWR site's catchment, and that site sets a farm's charge. */
function crossedCases(count: number): Crossed[] {
	const found: Crossed[] = [];
	for (let seed = 1; found.length < count && seed < 800; seed++) {
		const input = randomInput(seed, { maxDays: 400 });
		let out: ModelOutput;
		try {
			out = runModel(input);
		} catch {
			continue;
		}
		const sites = siteCatchments(input);
		const moved = input.model.transfers.filter((r) => find(out, r.fromNodeId, transferRuleKey(r.id))?.values.some((v) => v > 0));
		const crossed = new Set(sites.flatMap((up, si) => (moved.some((r) => up.has(r.fromNodeId) !== up.has(r.toNodeId)) ? [si] : [])));
		if (!crossed.size) continue;
		const hit = out.series
			.filter((s) => s.key === EWR_BINDING_SERIES.key)
			.flatMap((s) => {
				const t = s.values.findIndex((v) => crossed.has(v));
				return t >= 0 ? [{ farm: s.nodeId!, t }] : [];
			})[0];
		if (hit) found.push({ input, out, ...hit });
	}
	return found;
}

/** The run with one series' value on day t replaced. */
function perturb(out: ModelOutput, nodeId: string | null, key: string, t: number, f: (v: number) => number): ModelOutput {
	return { ...out, series: out.series.map((s) => (s.nodeId === nodeId && s.key === key ? { ...s, values: s.values.map((v, i) => (i === t ? f(v) : v)) } : s)) };
}

/** The run as one saved before engine 1.6.0: no per-rule series. */
const withoutRules = (out: ModelOutput): ModelOutput => ({ ...out, series: out.series.filter((s) => !parseTransferRuleKey(s.key)) });

describe('the stored per-rule transfer volumes', () => {
	it('are stored on the source farm for every rule that can move water, and only those, adding up to each farm’s net transfer', () => {
		let rulesSeen = 0;
		let inert = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const base = randomInput(seed, { maxDays: 300 });
			// A rule that can never move water (no month, or no capacity) has no series.
			const input: ModelInput =
				seed % 5 === 0 && base.model.transfers.length
					? { ...base, model: { ...base.model, transfers: base.model.transfers.map((r, k) => (k === 0 ? { ...r, months: [] } : k === 1 ? { ...r, maxRateM3s: 0 } : r)) } }
					: base;
			let out: ModelOutput;
			try {
				out = runModel(input);
			} catch {
				continue;
			}
			const rules = farmRules(input.model.transfers, input.model.nodes);
			const stored = out.series.filter((x) => parseTransferRuleKey(x.key));
			expect(new Set(stored.map((x) => `${x.nodeId}|${x.key}`))).toEqual(new Set(rules.filter(canMove).map((r) => `${r.fromNodeId}|${transferRuleKey(r.id)}`)));
			for (const x of stored) expect(x.values.every((v) => v >= 0)).toBe(true);
			rulesSeen += stored.length;
			inert += rules.filter((r) => !canMove(r)).length;
			const vol = readRuleVolumes(rules, out.days, (id, key) => find(out, id, key)?.values)!;
			expect(vol).not.toBeNull();
			for (const n of input.model.nodes.filter((x) => x.kind === 'farm')) {
				const J = find(out, n.id, 'transfer')!.values;
				for (let t = 0; t < out.days; t++) {
					let net = 0;
					// A river off-take (engine 1.14.0) isn't in the farms' net transfer (it has offtake_in / offtake_out).
					rules.forEach((r, k) => {
						if (isRiverOfftake(r)) return;
						if (r.toNodeId === n.id) net += vol[k]![t]!;
						if (r.fromNodeId === n.id) net -= vol[k]![t]!;
					});
					expect(Math.abs(net - J[t]!)).toBeLessThan(1e-6 + 1e-9 * Math.abs(J[t]!));
				}
			}
		}
		expect(rulesSeen).toBeGreaterThan(20);
		expect(inert).toBeGreaterThan(0);
	});

	const cases = crossedCases(5);

	it('make the attribution self-check exact at a site a transfer crosses: a perturbed charge there is caught', () => {
		expect(cases.length).toBeGreaterThanOrEqual(3);
		for (const { input, out, farm, t } of cases) {
			expect(checkEwrAttribution(input, out)).toBeNull();
			// 1 % more charge on a day the crossed site set it: more than its share there.
			const bad = perturb(out, farm, 'ewr_charge', t, (v) => v * 1.01);
			expect(checkEwrAttribution(input, bad)).toMatch(new RegExp(`^${farm} day ${t}: EWR charge .* ≠ its (largest share|share)`));
		}
	});

	it('an older run (no per-rule series) keeps the fallback: it passes, and a charge set at the crossed site goes unchecked', () => {
		let missed = 0;
		for (const { input, out, farm, t } of cases) {
			const old = withoutRules(out);
			expect(checkEwrAttribution(input, old)).toBeNull();
			if (checkEwrAttribution(input, perturb(old, farm, 'ewr_charge', t, (v) => v * 1.01)) === null) missed++;
		}
		// The gap the per-rule volumes close.
		expect(missed).toBeGreaterThan(0);
	});

	it('a per-rule volume that doesn’t add up to the farms’ net transfers, is negative, or is missing fails the self-check', () => {
		// A dam rule's volume (a river off-take's, engine 1.14.0, is held to offtake_out / offtake_in instead).
		const dam = (c: (typeof cases)[number], key: string) => !isRiverOfftake(c.input.model.transfers.find((r) => r.id === parseTransferRuleKey(key))!);
		const damSeries = (c: (typeof cases)[number]) => c.out.series.find((x) => parseTransferRuleKey(x.key) && dam(c, x.key) && x.values.some((v) => v > 0));
		const picked = cases.find((c) => damSeries(c))!;
		const { input, out } = picked;
		const s = damSeries(picked)!;
		const t = s.values.findIndex((v) => v > 0);
		expect(checkEwrAttribution(input, perturb(out, s.nodeId, s.key, t, (v) => v * 2))).toMatch(/its transfer rules move .* net, but its transfer is/);
		expect(checkEwrAttribution(input, perturb(out, s.nodeId, s.key, t, () => -1))).toMatch(/must be ≥ 0/);
		const multi = cases.find((c) => c.out.series.filter((x) => parseTransferRuleKey(x.key)).length > 1);
		if (multi) {
			const drop = multi.out.series.find((x) => parseTransferRuleKey(x.key))!;
			expect(checkEwrAttribution(multi.input, { ...multi.out, series: multi.out.series.filter((x) => x !== drop) })).toMatch(/have a stored volume/);
		}
	});
});
