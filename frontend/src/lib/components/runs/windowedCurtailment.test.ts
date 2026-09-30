// The wiring of the reporting-window picker to the engine's
// prepareCurtailment: the keys it fetches, the stored series it hands over
// (a non-finite day as null, as the API stores them) and the window
// resolveWindow picks. The engine's curtailmentOverWindow.test.ts checks the
// table itself against runModel on many seeded runs; here a few synthetic runs
// go through the whole path the panel takes, binding sites included.
import { runModel, type ModelInput, type ModelOutput } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { curtailmentSeriesKeys, missingSeries, prepareWindowed } from './windowedCurtailment';
import { resolveWindow, type WindowChoice } from './reportWindow';

/** The run's series as the API stores them: a non-finite day is null. */
function storedLookup(out: ModelOutput) {
	const m = new Map(out.series.map((s) => [`${s.nodeId ?? ''}|${s.key}`, s.values.map((v) => (Number.isFinite(v) ? v : null))]));
	return (nodeId: string | null, key: string) => m.get(`${nodeId ?? ''}|${key}`);
}

const withWindow = (input: ModelInput, start: string, end: string): ModelInput => ({ ...input, settings: { ...input.settings, reportStart: start, reportEnd: end } });

/** Seeds whose run has farms (and so a curtailment table with rows). */
function runs(count: number) {
	const out: { input: ModelInput; run: ModelOutput }[] = [];
	for (let seed = 1; out.length < count && seed < 400; seed++) {
		const input = randomInput(seed, { maxDays: 400 });
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

const cases = runs(8);
// The run's snapshot as ReportWindowPanel hands it over: the crops, crop areas and A-pan too (engine 0.43.0).
const network = (input: ModelInput) => ({
	nodes: input.model.nodes,
	transfers: input.model.transfers,
	crops: input.model.crops,
	cropAreas: input.model.cropAreas,
	apanMm: input.settings.apanMm as number[] | undefined,
	demandObjects: input.model.demandObjects
});

describe('the reporting window, worked out by the engine', () => {
	it('equals runModel with the picked window as the project setting, the binding EWR site included', () => {
		expect(cases).toHaveLength(8);
		let bound = 0;
		const choices: WindowChoice[] = [{ preset: 'project' }, { preset: 'last7' }, { preset: 'last30' }, { preset: 'all' }, { preset: 'custom', start: '1900-01-01', end: '2999-12-31' }];
		for (const { input, run } of cases) {
			const stored = run.summary.curtailment!;
			const prepared = prepareWindowed(run, network(input), storedLookup(run));
			for (const choice of choices) {
				const res = resolveWindow(choice, run, stored);
				if (!res.ok) throw new Error(res.error);
				const w = res.window;
				const got = prepared.over(w);
				const expected = choice.preset === 'project' ? stored : runModel(withWindow(input, w.reportStart, w.reportEnd)).summary.curtailment!;
				if (got.bindingApproximate) {
					const strip = (c: typeof expected) => ({ ...c, farms: c.farms.map((f) => ({ ...f, ewrBindingSiteId: null })) });
					expect(strip(got.curtailment)).toEqual(strip(expected));
				} else {
					expect(got.curtailment).toEqual(expected);
					if (choice.preset !== 'project' && got.curtailment.farms.some((f) => f.ewrBindingSiteId)) bound++;
				}
			}
		}
		// The column the browser couldn't fill before: some picked window has a farm charged by a site.
		expect(bound).toBeGreaterThan(0);
	});

	it('curtails a farm whose crops carry their own irrigation efficiency on the efficiency the run used', () => {
		let checked = 0;
		for (const { input } of cases) {
			const drip = structuredClone(input);
			drip.model.crops.forEach((c, i) => (c.irrigationEfficiency = i % 2 ? 0.95 : 0.55));
			const run = runModel(drip);
			if (!run.summary.curtailment?.farms.length) continue;
			const res = resolveWindow({ preset: 'project' }, run, run.summary.curtailment);
			if (!res.ok) throw new Error(res.error);
			const got = prepareWindowed(run, network(drip), storedLookup(run)).over(res.window);
			if (got.bindingApproximate) continue;
			expect(got.curtailment.farms).toEqual(run.summary.curtailment.farms);
			checked++;
		}
		expect(checked).toBeGreaterThan(0);
	});

	it('holds a unit’s basic-needs floor over a picked window as runModel does (engine 1.38.0)', () => {
		let floored = 0;
		for (let seed = 1; seed <= 120 && floored < 3; seed++) {
			const input = randomInput(seed, { maxDays: 300 });
			if (!input.model.demandObjects?.length) continue;
			// Every object a town of 2 000 people, every farm cut to 10 %: the floor holds on each.
			for (const o of input.model.demandObjects) Object.assign(o, { category: 'municipal', population: 2000 });
			for (const n of input.model.nodes) if (n.kind === 'farm') n.demandFactor = new Array(12).fill(0.1);
			const run = runModel(input);
			const stored = run.summary.curtailment;
			if (!stored?.farms.some((f) => f.basicNeedsM3Day !== undefined) || run.days < 40) continue;
			floored++;
			const keys = curtailmentSeriesKeys(stored, network(input))!;
			expect(keys.some((k) => k.key === 'basic_needs')).toBe(true);
			expect(missingSeries(keys, run.series)).toEqual([]);
			const res = resolveWindow({ preset: 'last30' }, run, stored);
			if (!res.ok) throw new Error(res.error);
			const got = prepareWindowed(run, network(input), storedLookup(run)).over(res.window);
			const expected = runModel(withWindow(input, res.window.reportStart, res.window.reportEnd)).summary.curtailment!;
			const strip = (c: typeof expected) => c.farms.map((f) => ({ ...f, ewrBindingSiteId: null }));
			expect(strip(got.curtailment)).toEqual(strip(expected));
		}
		expect(floored).toBeGreaterThan(0);
	});

	it('fetches every series the engine reads, and the run stores each of them', () => {
		for (const { input, run } of cases) {
			const keys = curtailmentSeriesKeys(run.summary.curtailment!, network(input))!;
			expect(keys.length).toBeGreaterThan(0);
			expect(missingSeries(keys, run.series)).toEqual([]);
			// The outlet's series are the catchment's.
			if (run.summary.curtailment!.ewrSites?.[0]?.isOutlet) expect(keys).toContainEqual({ nodeId: null, key: 'ewr_charged' });
		}
	});

	it('given the run’s stored series, fetches the stored binding sites and not the flows (engine ≥ 1.5.0), and works from those alone', () => {
		let withBinding = 0;
		for (const { input, run } of cases) {
			const keys = curtailmentSeriesKeys(run.summary.curtailment!, network(input), run.series)!;
			expect(missingSeries(keys, run.series)).toEqual([]);
			expect(keys.some((k) => k.key === 'outflow' || k.key === 'runoff')).toBe(false);
			if (keys.some((k) => k.key === 'ewr_binding_site')) withBinding++;
			// Only the listed series are handed over: the table is still the stored one.
			const listed = new Set(keys.map((k) => `${k.nodeId ?? ''}|${k.key}`));
			const get = storedLookup(run);
			const only = (nodeId: string | null, key: string) => (listed.has(`${nodeId ?? ''}|${key}`) ? get(nodeId, key) : undefined);
			const res = resolveWindow({ preset: 'project' }, run, run.summary.curtailment!);
			if (!res.ok) throw new Error(res.error);
			const got = prepareWindowed(run, network(input), only).over(res.window);
			expect(got.bindingApproximate).toBe(false);
			expect(got.curtailment).toEqual(run.summary.curtailment);
		}
		expect(withBinding).toBeGreaterThan(0);
	});

	it('fetches a rule-table site’s own shortfall when the charge followed the rule table (engine 1.3.0), and windows it as runModel does', () => {
		let ruled = 0;
		for (const { input } of runs(40)) {
			if (!input.settings.ewrRules?.length) continue;
			const byRule: ModelInput = { ...input, settings: { ...input.settings, ewrChargeSource: 'ruleTable' } };
			const run = runModel(byRule);
			const sites = run.summary.curtailment!.ewrSites!.filter((s) => s.ewrSource === 'ruleTable');
			if (!sites.length) continue;
			ruled++;
			const keys = curtailmentSeriesKeys(run.summary.curtailment!, network(byRule))!;
			expect(missingSeries(keys, run.series)).toEqual([]);
			for (const s of sites) {
				const nodeId = s.isOutlet ? null : s.nodeId;
				expect(keys).toContainEqual({ nodeId, key: 'ewr_charge_shortfall' });
				expect(keys).not.toContainEqual({ nodeId, key: 'ewr_shortfall' });
			}
			const res = resolveWindow({ preset: 'last30' }, run, run.summary.curtailment!);
			if (!res.ok) throw new Error(res.error);
			const got = prepareWindowed(run, network(byRule), storedLookup(run)).over(res.window);
			if (got.bindingApproximate) continue;
			expect(got.curtailment).toEqual(runModel(withWindow(byRule, res.window.reportStart, res.window.reportEnd)).summary.curtailment);
		}
		expect(ruled).toBeGreaterThan(0);
	});

	it('says a run saved before the EWR charge cannot be re-windowed', () => {
		const { input, run } = cases[0]!;
		expect(curtailmentSeriesKeys({ ...run.summary.curtailment!, ewrAttribution: undefined }, network(input))).toBeNull();
		expect(missingSeries([{ nodeId: 'a', key: 'demand' }, { nodeId: null, key: 'ewr_charged' }], [{ nodeId: null, key: 'ewr_charged' }])).toEqual([{ nodeId: 'a', key: 'demand' }]);
	});

	it('throws, rather than making up figures, when a stored series is short', () => {
		const { input, run } = cases[0]!;
		const get = storedLookup(run);
		const farm = input.model.nodes.find((n) => n.kind === 'farm')!;
		expect(() => prepareWindowed(run, network(input), (nodeId, key) => (nodeId === farm.id && key === 'demand' ? get(nodeId, key)!.slice(1) : get(nodeId, key)))).toThrow(/demand series has/);
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('averages over the same days east and west of UTC', () => {
			const { input, run } = cases[0]!;
			const stored = run.summary.curtailment!;
			const table = () => {
				const res = resolveWindow({ preset: 'last7' }, run, stored);
				if (!res.ok) throw new Error(res.error);
				return prepareWindowed(run, network(input), storedLookup(run)).over(res.window).curtailment;
			};
			const expected = table();
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg']) {
				process.env.TZ = zone;
				expect(table(), zone).toEqual(expected);
			}
		});
	});
});
