// curtailmentOverWindow must be runModel's own curtailment table for the
// same window (issue #44): seeded synthetic runs are run once, their stored
// series re-windowed, and compared with runModel run again with that window
// as the project's report window: farms (binding EWR site included), other
// water users and EWR sites. Over the run's own window it is the stored table.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ReportWindow } from '../network/curtailment';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { EWR_BINDING_SERIES } from '../network/bindingSeries';
import { parseTransferRuleKey } from '../network/transferSeries';
import { isRiverOfftake } from '../network/offtake';
import { randomInput } from '../testing/fuzz';
import { curtailmentOverWindow, curtailmentSeriesKeys, prepareCurtailment, ProjectionInputError, type CurtailmentRun } from './farmProjection';

/** A saved run as the API stores it (a non-finite day is null), recording which series are read. */
function asRun(input: ModelInput, out: ModelOutput, read?: Set<string>): CurtailmentRun {
	const byKey = new Map(out.series.map((s) => [`${s.nodeId ?? ''}|${s.key}`, s.values.map((v) => (Number.isFinite(v) ? v : null))]));
	return {
		startDate: out.startDate,
		endDate: out.endDate,
		nodes: input.model.nodes,
		transfers: input.model.transfers,
		// Crops under their own irrigation efficiency (engine 0.43.0) set a farm's consumptive share.
		crops: input.model.crops,
		cropAreas: input.model.cropAreas,
		apanMm: input.settings?.apanMm,
		// A unit with demand objects (engine 1.7.0) takes its consumptive share from its stored return flow.
		...(input.model.demandObjects ? { demandObjects: input.model.demandObjects } : {}),
		series: (nodeId, key) => {
			read?.add(`${nodeId ?? ''}|${key}`);
			return byKey.get(`${nodeId ?? ''}|${key}`);
		}
	};
}

/** The same run as one saved before engine 1.5.0, which stored no binding site (nor, before 1.6.0, per-rule transfers): it is recomputed from the flows. */
function asOldRun(input: ModelInput, out: ModelOutput, read?: Set<string>): CurtailmentRun {
	const r = asRun(input, out, read);
	return { ...r, series: (nodeId, key) => (key === EWR_BINDING_SERIES.key || parseTransferRuleKey(key) ? undefined : r.series(nodeId, key)) };
}

/** The same run with its binding sites hidden but its per-rule transfer volumes kept (engine ≥ 1.6.0): the recompute reads the rules. */
function asRuleRun(input: ModelInput, out: ModelOutput, read?: Set<string>): CurtailmentRun {
	const r = asRun(input, out, read);
	return { ...r, series: (nodeId, key) => (key === EWR_BINDING_SERIES.key ? undefined : r.series(nodeId, key)) };
}

const withWindow = (input: ModelInput, w: ReportWindow): ModelInput => ({ ...input, settings: { ...input.settings, reportStart: w.reportStart, reportEnd: w.reportEnd } });

/** Day indices from to … to of a run, with their dates. */
function win(run: ModelOutput, from: number, to: number): ReportWindow {
	const d0 = toEpochDay(run.startDate);
	return { from, to, reportStart: fromEpochDay(d0 + from), reportEnd: fromEpochDay(d0 + to) };
}

/** The windows checked: the last 7 and 30 days, the whole run, a middle stretch and a single day. */
function windows(run: ModelOutput): ReportWindow[] {
	const last = run.days - 1;
	return [win(run, last - 6, last), win(run, last - 29, last), win(run, 0, last), win(run, Math.floor(run.days / 4), Math.floor((3 * run.days) / 4)), win(run, Math.floor(run.days / 2), Math.floor(run.days / 2))];
}

/** Seeded runs with farms and at least 40 days. */
function cases(count: number, maxDays = 400) {
	const out: { input: ModelInput; run: ModelOutput }[] = [];
	for (let seed = 1; out.length < count && seed < 600; seed++) {
		const input = randomInput(seed, { maxDays });
		let run: ModelOutput;
		try {
			run = runModel(input);
		} catch {
			continue;
		}
		if (run.summary.curtailment?.farms.length && run.days >= 40) out.push({ input, run });
	}
	return out;
}

const strip = <T extends { farms: { ewrBindingSiteId?: string | null }[] }>(c: T): T => ({ ...c, farms: c.farms.map((f) => ({ ...f, ewrBindingSiteId: null })) });

describe('curtailmentOverWindow', () => {
	const runs = cases(40);

	it('has seeded runs to check, with other water users, gauges, transfers and charged farms', () => {
		expect(runs).toHaveLength(40);
		expect(runs.some((c) => c.run.summary.curtailment!.otherUsers?.length)).toBe(true);
		expect(runs.some((c) => (c.run.summary.curtailment!.ewrSites?.length ?? 0) > 1)).toBe(true);
		expect(runs.some((c) => c.input.model.transfers.some((t) => t.enabled))).toBe(true);
		expect(runs.some((c) => c.run.summary.curtailment!.farms.some((f) => f.ewrBindingSiteId))).toBe(true);
	});

	it('is the stored table exactly over the run’s own window', () => {
		for (const { input, run } of runs) {
			const stored = run.summary.curtailment!;
			const d0 = toEpochDay(run.startDate);
			const own = { from: toEpochDay(stored.reportStart) - d0, to: toEpochDay(stored.reportEnd) - d0, reportStart: stored.reportStart, reportEnd: stored.reportEnd };
			const got = curtailmentOverWindow(asRun(input, run), own);
			if (got.bindingApproximate) expect(strip(got.curtailment)).toEqual(strip(stored));
			else expect(got.curtailment).toEqual(stored);
		}
	});

	it('equals runModel with the window as the project setting, binding sites included', () => {
		let bound = 0;
		for (const { input, run } of runs) {
			const prepared = prepareCurtailment(asRun(input, run));
			for (const w of windows(run)) {
				const again = runModel(withWindow(input, w)).summary.curtailment!;
				const got = prepared.over(w);
				expect(got.curtailment.reportStart).toBe(w.reportStart);
				if (got.bindingApproximate) expect(strip(got.curtailment)).toEqual(strip(again));
				else expect(got.curtailment).toEqual(again);
				if (!got.bindingApproximate && got.curtailment.farms.some((f) => f.ewrBindingSiteId)) bound++;
			}
		}
		// The binding site is what the browser couldn't recompute before: make sure it is exercised.
		expect(bound).toBeGreaterThan(10);
	});

	it('finds a gauge, not only the outlet, setting a farm’s charge over some window', () => {
		let gaugeBinds = 0;
		for (const { input, run } of cases(80, 600)) {
			const prepared = prepareCurtailment(asRun(input, run));
			for (const w of windows(run)) {
				const got = prepared.over(w);
				if (got.bindingApproximate) continue;
				const outlet = got.sites.find((s) => s.isOutlet)?.nodeId;
				if (got.curtailment.farms.some((f) => f.ewrBindingSiteId && f.ewrBindingSiteId !== outlet)) {
					gaugeBinds++;
					expect(got.curtailment.farms).toEqual(runModel(withWindow(input, w)).summary.curtailment!.farms);
				}
			}
		}
		expect(gaugeBinds).toBeGreaterThan(0);
	});

	it('reads exactly the series curtailmentSeriesKeys lists, the stored binding sites and no flows (engine ≥ 1.5.0)', () => {
		let flowsSkipped = 0;
		for (const { input, run } of runs) {
			const stored = new Set(run.series.map((s) => `${s.nodeId ?? ''}|${s.key}`));
			const has = (nodeId: string | null, key: string) => stored.has(`${nodeId ?? ''}|${key}`);
			for (const otherUsers of [true, false]) {
				const read = new Set<string>();
				curtailmentOverWindow(asRun(input, run, read), win(run, 0, run.days - 1), { otherUsers });
				// ewr_charge_shortfall is looked for at every site, and read only where the run stored it.
				const used = new Set([...read].filter((k) => !k.endsWith('|ewr_charge_shortfall') || stored.has(k)));
				const keys = curtailmentSeriesKeys(input.model.nodes, input.model.transfers, { otherUsers, demandObjects: input.model.demandObjects }, has).map((k) => `${k.nodeId ?? ''}|${k.key}`);
				expect(new Set(keys)).toEqual(used);
				expect(keys).toHaveLength(used.size);
				if (![...read].some((k) => k.endsWith('|outflow'))) flowsSkipped++;
			}
		}
		expect(flowsSkipped).toBe(runs.length * 2);
	});

	it('reads exactly the series curtailmentSeriesKeys lists for a run saved before 1.5.0 (the recompute’s flows)', () => {
		let recomputed = 0;
		for (const { input, run } of runs) {
			const stored = new Set(run.series.filter((s) => s.key !== EWR_BINDING_SERIES.key && !parseTransferRuleKey(s.key)).map((s) => `${s.nodeId ?? ''}|${s.key}`));
			const has = (nodeId: string | null, key: string) => stored.has(`${nodeId ?? ''}|${key}`);
			const read = new Set<string>();
			curtailmentOverWindow(asOldRun(input, run, read), win(run, 0, run.days - 1));
			for (const k of [...read]) if (k.endsWith('|ewr_charge_shortfall') && !stored.has(k)) read.delete(k);
			const keys = curtailmentSeriesKeys(input.model.nodes, input.model.transfers, { demandObjects: input.model.demandObjects }, has).map((k) => `${k.nodeId ?? ''}|${k.key}`);
			// Without `has` too (and the rule-table sites as the Runs tab passes them): the flows are listed.
			const ruleTableSites = run.summary.curtailment!.ewrSites!.filter((s) => s.ewrSource === 'ruleTable').map((s) => (s.isOutlet ? null : s.nodeId));
			const blind = new Set(curtailmentSeriesKeys(input.model.nodes, input.model.transfers, { ruleTableSites, demandObjects: input.model.demandObjects }).map((k) => `${k.nodeId ?? ''}|${k.key}`));
			const needsRecompute = run.series.some((s) => s.key === EWR_BINDING_SERIES.key);
			if (needsRecompute) {
				recomputed++;
				expect(new Set(keys)).toEqual(read);
				expect(blind).toEqual(read);
			} else {
				// No farm upstream of two sites: the binding site follows from the charge, nothing is recomputed.
				for (const k of read) expect(new Set(keys).has(k)).toBe(true);
			}
		}
		expect(recomputed).toBeGreaterThan(5);
	});

	it('the stored binding site equals the recompute’s off a transfer loop, and is exact on one (engine ≥ 1.5.0)', () => {
		let compared = 0;
		let loops = 0;
		for (const c of cases(80, 600)) {
			// A model with a river off-take (engine 1.14.0) never had an older run to compare with: compare it without them.
			const offtakes = c.input.model.transfers.some((t) => t.enabled && isRiverOfftake(t));
			const input = offtakes ? { ...c.input, model: { ...c.input.model, transfers: c.input.model.transfers.filter((t) => !isRiverOfftake(t)) } } : c.input;
			const run = offtakes ? runModel(input) : c.run;
			const now = prepareCurtailment(asRun(input, run));
			const before = prepareCurtailment(asOldRun(input, run));
			for (const w of windows(run)) {
				const stored = now.over(w);
				const old = before.over(w);
				expect(stored.bindingApproximate).toBe(false);
				if (old.bindingApproximate) {
					// A loop: only the stored series gives runModel's binding sites.
					loops++;
					expect(stored.curtailment.farms).toEqual(runModel(withWindow(input, w)).summary.curtailment!.farms);
				} else {
					compared++;
					expect(stored.curtailment).toEqual(old.curtailment);
				}
			}
		}
		expect(compared).toBeGreaterThan(100);
		expect(loops).toBeGreaterThan(0);
	});

	it('recomputes exactly from the stored per-rule transfer volumes, a transfer loop included (engine ≥ 1.6.0)', () => {
		let loops = 0;
		let withRules = 0;
		for (const { input, run } of cases(80, 600)) {
			if (!run.series.some((s) => parseTransferRuleKey(s.key))) continue;
			withRules++;
			const rules = prepareCurtailment(asRuleRun(input, run));
			const before = prepareCurtailment(asOldRun(input, run));
			for (const w of windows(run)) {
				const got = rules.over(w);
				expect(got.bindingApproximate).toBe(false);
				expect(got.curtailment).toEqual(prepareCurtailment(asRun(input, run)).over(w).curtailment);
				if (before.over(w).bindingApproximate) {
					loops++;
					expect(got.curtailment.farms).toEqual(runModel(withWindow(input, w)).summary.curtailment!.farms);
				}
			}
			// Given the stored series, the per-rule volumes are listed in place of the farms' net transfers.
			const stored = new Set(run.series.filter((s) => s.key !== EWR_BINDING_SERIES.key).map((s) => `${s.nodeId ?? ''}|${s.key}`));
			const has = (nodeId: string | null, key: string) => stored.has(`${nodeId ?? ''}|${key}`);
			const read = new Set<string>();
			curtailmentOverWindow(asRuleRun(input, run, read), win(run, 0, run.days - 1));
			const used = new Set([...read].filter((k) => stored.has(k)));
			const keys = curtailmentSeriesKeys(input.model.nodes, input.model.transfers, { demandObjects: input.model.demandObjects }, has).map((k) => `${k.nodeId ?? ''}|${k.key}`);
			if (run.series.some((s) => s.key === EWR_BINDING_SERIES.key)) {
				expect(new Set(keys)).toEqual(used);
				expect(keys.some((k) => k.endsWith('|transfer'))).toBe(false);
			}
		}
		expect(withRules).toBeGreaterThan(5);
		expect(loops).toBeGreaterThan(0);
	});

	it('reads exactly the series curtailmentSeriesKeys lists, a rule-table site’s own shortfall included', () => {
		let ruleRuns = 0;
		for (const { input, run } of runs) {
			// As the Runs tab passes them: the stored sites whose charge followed a rule table (engine ≥ 1.3.0).
			const ruleTableSites = run.summary.curtailment!.ewrSites!.filter((s) => s.ewrSource === 'ruleTable').map((s) => (s.isOutlet ? null : s.nodeId));
			if (ruleTableSites.length) ruleRuns++;
			const stored = new Set(run.series.map((s) => `${s.nodeId ?? ''}|${s.key}`));
			for (const otherUsers of [true, false]) {
				const read = new Set<string>();
				curtailmentOverWindow(asRun(input, run, read), win(run, 0, run.days - 1), { otherUsers });
				// ewr_charge_shortfall is looked for at every site, and read only where the run stored it.
				const used = new Set([...read].filter((k) => !k.endsWith('|ewr_charge_shortfall') || stored.has(k)));
				// With the run's stored series too, as the Runs tab passes them: its binding sites (engine ≥ 1.5.0) replace the flows.
				const has = (nodeId: string | null, key: string) => stored.has(`${nodeId ?? ''}|${key}`);
				const keys = curtailmentSeriesKeys(input.model.nodes, input.model.transfers, { otherUsers, ruleTableSites, demandObjects: input.model.demandObjects }, has).map((k) => `${k.nodeId ?? ''}|${k.key}`);
				expect(new Set(keys)).toEqual(used);
				expect(keys).toHaveLength(used.size);
			}
		}
		expect(ruleRuns).toBeGreaterThan(0);
	});

	it('leaves the other water users out when asked, and only then', () => {
		const withUsers = runs.find((c) => c.run.summary.curtailment!.otherUsers?.length)!;
		const w = win(withUsers.run, 0, withUsers.run.days - 1);
		expect(curtailmentOverWindow(asRun(withUsers.input, withUsers.run), w, { otherUsers: false }).curtailment.otherUsers).toBeUndefined();
		expect(curtailmentOverWindow(asRun(withUsers.input, withUsers.run), w).curtailment.otherUsers).toEqual(runModel(withWindow(withUsers.input, w)).summary.curtailment!.otherUsers);
	});

	it('refuses a window outside the run, an empty one, and a run missing a series', () => {
		const { input, run } = runs[0]!;
		const prepared = prepareCurtailment(asRun(input, run));
		expect(() => prepared.over(win(run, 0, run.days))).toThrow(ProjectionInputError);
		expect(() => prepared.over(win(run, -1, 3))).toThrow(ProjectionInputError);
		expect(() => prepared.over(win(run, 5, 4))).toThrow(/empty/);
		const farm = input.model.nodes.find((n) => n.kind === 'farm')!;
		const r = asRun(input, run);
		const gap: CurtailmentRun = { ...r, series: (nodeId, key) => (nodeId === farm.id && key === 'ewr_charge_irrigation' ? undefined : r.series(nodeId, key)) };
		expect(() => prepareCurtailment(gap)).toThrow(/no ewr_charge_irrigation series/);
	});

	describe('under a skewed time zone', () => {
		let tz: string | undefined;
		beforeEach(() => {
			tz = process.env.TZ;
		});
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('averages over the same days east and west of UTC', () => {
			const { input, run } = runs[0]!;
			const w = windows(run)[0]!;
			const expected = curtailmentOverWindow(asRun(input, run), w).curtailment;
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg']) {
				process.env.TZ = zone;
				expect(curtailmentOverWindow(asRun(input, run), win(run, w.from, w.to)).curtailment, zone).toEqual(expected);
			}
		});
	});
});
