// A gauge taken off the EWR sites (engine ≥ 1.5.0, audit Q17 follow-on,
// WP-3.7, docs/model.md §2.7b): its shortfall charges nobody and it drops out
// of the site list, the curtailment table and the Reserve rule tables, while
// every other site is charged as before. Absent and true are the same run to
// the bit (the positive control), and the attribution self-checks still hold.
import { describe, expect, it } from 'vitest';
import { blankEwrRuleTable } from './reserve/rules';
import { modelRuleProblems } from './modelRules';
import type { ModelInput, ModelOutput, NetworkNode } from './project';
import { runModel } from './run';
import { randomInput } from './testing/fuzz';
import { checkAll, sameOutput } from './testing/invariants';

const series = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key);
const charged = (out: ModelOutput, nodeId: string) => series(out, nodeId, 'ewr_charged')?.values.some((v) => v < 0) ?? false;
const withFlag = (input: ModelInput, id: string, ewrSite: boolean | undefined): ModelInput => {
	const copy = structuredClone(input);
	for (const n of copy.model.nodes) {
		if (n.id !== id) continue;
		if (ewrSite === undefined) delete n.ewrSite;
		else n.ewrSite = ewrSite;
	}
	return copy;
};

/** Seeded networks whose mid-catchment gauge charges a farm on some day. */
function gaugeCases(count: number): { input: ModelInput; out: ModelOutput; gauge: NetworkNode }[] {
	const found: { input: ModelInput; out: ModelOutput; gauge: NetworkNode }[] = [];
	for (let seed = 1; found.length < count && seed < 400; seed++) {
		const input = randomInput(seed, { maxDays: 300 });
		let out: ModelOutput;
		try {
			out = runModel(input);
		} catch {
			continue;
		}
		const gauge = input.model.nodes.find((n) => n.kind === 'gauge' && n.downstreamNodeId !== null && charged(out, n.id));
		if (gauge) found.push({ input, out, gauge });
	}
	return found;
}

describe('the EWR site flag on a gauge (engine 1.5.0)', () => {
	const cases = gaugeCases(8);

	it('has networks whose gauge charges a farm', () => {
		expect(cases.length).toBe(8);
	});

	it('true or absent: the same run to the bit, the gauge an EWR site (positive control)', () => {
		for (const { input, out, gauge } of cases) {
			const explicit = runModel(withFlag(input, gauge.id, true));
			expect(sameOutput(out, explicit)).toBe(true);
			expect(out.summary.curtailment!.ewrSites!.map((s) => s.nodeId)).toContain(gauge.id);
			expect(series(out, gauge.id, 'ewr_charged')).toBeDefined();
		}
	});

	it('false: the gauge charges nobody and leaves the site list; its flow and shortfall stay', () => {
		let casesLower = 0;
		for (const { input, out, gauge } of cases) {
			const off = runModel(withFlag(input, gauge.id, false));
			expect(series(off, gauge.id, 'ewr_charged')).toBeUndefined();
			expect(series(off, gauge.id, 'ewr_natural')).toBeUndefined();
			expect(off.summary.curtailment!.ewrSites!.map((s) => s.nodeId)).not.toContain(gauge.id);
			expect(off.summary.curtailment!.ewrSites!.length).toBe(out.summary.curtailment!.ewrSites!.length - 1);
			// Measuring is unchanged: the same flow and EWR shortfall at the gauge.
			expect(series(off, gauge.id, 'outflow')!.values).toEqual(series(out, gauge.id, 'outflow')!.values);
			expect(series(off, gauge.id, 'ewr_shortfall')!.values).toEqual(series(out, gauge.id, 'ewr_shortfall')!.values);
			// The other sites are charged exactly as before.
			for (const s of out.summary.curtailment!.ewrSites!) {
				if (s.nodeId === gauge.id) continue;
				const key = s.isOutlet ? null : s.nodeId;
				expect(series(off, key, 'ewr_charged')!.values).toEqual(series(out, key, 'ewr_charged')!.values);
			}
			// No farm is charged more; where the gauge set a charge, it is lower now.
			let lower = 0;
			for (const n of input.model.nodes.filter((x) => x.kind === 'farm')) {
				const a = series(out, n.id, 'ewr_charge')!.values;
				const b = series(off, n.id, 'ewr_charge')!.values;
				for (let t = 0; t < a.length; t++) {
					expect(b[t]!).toBeGreaterThanOrEqual(a[t]! - 1e-9 * Math.abs(a[t]!));
					if (b[t]! > a[t]! + 1e-9 * Math.abs(a[t]!)) lower++;
				}
			}
			if (lower) casesLower++;
			expect(checkAll(withFlag(input, gauge.id, false), 1)).toBeNull();
		}
		expect(casesLower).toBeGreaterThan(0);
	});

	it('false: a Reserve rule table at that gauge is skipped with a warning, one at the outlet still runs', () => {
		const { input, gauge } = cases[0]!;
		const table = (siteNodeId: string | null) => ({ ...blankEwrRuleTable(siteNodeId), source: 'Invented test table', ewr: Array.from({ length: 12 }, () => [0.5, 0.4, 0.3, 0.3, 0.2, 0.2, 0.1, 0.1, 0.05, 0.01]) });
		const withTables = (i: ModelInput): ModelInput => ({ ...i, settings: { ...i.settings, ewrRules: [table(null), table(gauge.id)] } });
		const on = runModel(withTables(input));
		expect(on.summary.ewrAssurance?.map((a) => a.nodeId)).toEqual([null, gauge.id]);
		const off = runModel(withTables(withFlag(input, gauge.id, false)));
		expect(off.summary.ewrAssurance?.map((a) => a.nodeId)).toEqual([null]);
		expect(off.summary.warnings.some((w) => w.includes(`EWR rule table for "${gauge.name}" skipped: the gauge is not marked as an EWR site`))).toBe(true);
	});

	it('false with the charge following the rule tables (ewrChargeSource ruleTable): the gauge’s table charges nobody', () => {
		const { input, gauge } = cases[0]!;
		// A demanding table, so a site that follows it is short on most days.
		const table = { ...blankEwrRuleTable(gauge.id), source: 'Invented test table', ewr: Array.from({ length: 12 }, () => [50, 40, 30, 30, 20, 20, 10, 10, 5, 1]) };
		const byRule = (i: ModelInput): ModelInput => ({ ...i, settings: { ...i.settings, ewrRules: [table], ewrChargeSource: 'ruleTable' } });
		// Positive control: ticked, the gauge's charge follows its table.
		const on = runModel(byRule(input));
		expect(series(on, gauge.id, 'ewr_charge_shortfall')).toBeDefined();
		expect(on.summary.curtailment!.ewrSites!.find((s) => s.nodeId === gauge.id)?.ewrSource).toBe('ruleTable');
		// Unticked: no site, no charge series, and the farms are charged as with the gauge off and no table at all.
		const off = runModel(byRule(withFlag(input, gauge.id, false)));
		expect(series(off, gauge.id, 'ewr_charge_shortfall')).toBeUndefined();
		expect(series(off, gauge.id, 'ewr_charged')).toBeUndefined();
		expect(off.summary.curtailment!.ewrSites!.map((s) => s.nodeId)).not.toContain(gauge.id);
		const plain = runModel(withFlag(input, gauge.id, false));
		for (const n of input.model.nodes.filter((x) => x.kind === 'farm')) {
			expect(series(off, n.id, 'ewr_charge')!.values).toEqual(series(plain, n.id, 'ewr_charge')!.values);
		}
		expect(checkAll(byRule(withFlag(input, gauge.id, false)), 1)).toBeNull();
	});

	it('the outlet always is an EWR site, and only a gauge can be taken off (model rules)', () => {
		const { input, gauge } = cases[0]!;
		// (Fuzz networks break other rules; only the EWR-site ones are looked at.)
		expect(modelRuleProblems(withFlag(input, gauge.id, false).model).filter((p) => /EWR site/.test(p))).toEqual([]);
		const outlet = input.model.nodes.find((n) => n.downstreamNodeId === null)!;
		expect(modelRuleProblems(withFlag(input, outlet.id, false).model).join()).toMatch(/is the outlet, which is always an EWR site/);
		const farm = input.model.nodes.find((n) => n.kind === 'farm')!;
		expect(modelRuleProblems(withFlag(input, farm.id, false).model).join()).toMatch(/only a gauge can be taken off the EWR sites/);
	});
});
