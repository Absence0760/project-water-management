// The EWR is assessed and reported in the baseline, never applied (issue #523
// B4, #90 R4 (b), #507 § Principle): the rules that keep water for the EWR (a
// pass-inflow release without amounts, a unit's or an off-take's
// handsOffEwr, the drought restriction's ewrTrigger) run only in a scenario.
// The baseline a run reads passes through withoutEwrKeepingRules (the
// backend's loadLiveInput), so:
//   - a baseline run is bit-identical with and without them stored;
//   - positive control: as stored they do change the run (the EWR binds), so
//     the identity above isn't vacuous;
//   - a scenario switching them back on with its ops runs exactly as the
//     rules did when stored.
// A set flow (a hands-off flow by month, a pass-inflow release with amounts)
// is an operating rule and stays.
import { describe, expect, it } from 'vitest';
import { testCatchment } from '../outlook/testCatchment';
import { OFFTAKE_DEFAULTS, type DroughtRestrictionRule, type ModelInput, type ModelOutput, type Transfer } from '../project';
import { runModelWithoutChecks } from '../run';
import { applyScenario } from '../scenario/overrides';
import type { ScenarioOp } from '../scenario/ops';
import { randomInput } from '../testing/fuzz';
import { baselineEwrRules, ewrReleaseRules, keepsEwr, scenarioOnlyLine, withoutEwrKeepingRules } from './ewrReleaseRules';

/** Every number compared with Object.is, so −0 against 0 or a NaN in another place fails too. */
function expectBitIdentical(a: ModelOutput, b: ModelOutput, what: string) {
	expect(a.series.map((s) => [s.nodeId, s.key]), what).toEqual(b.series.map((s) => [s.nodeId, s.key]));
	a.series.forEach((s, i) => {
		const other = b.series[i]!.values;
		expect(s.values.length, `${what} ${s.nodeId}/${s.key}`).toBe(other.length);
		const first = s.values.findIndex((v, t) => !Object.is(v, other[t]));
		expect(first, `${what} ${s.nodeId}/${s.key} differs from day ${first}`).toBe(-1);
	});
	expect(a.summary, what).toEqual(b.summary);
}

const RESTRICTION: DroughtRestrictionRule = { reviewDates: ['10-01', '01-01', '04-01', '07-01'], levels: [{ belowPct: 0.05, cuts: { crops: 0.3 } }] };
const TRIGGER = { siteNodeId: null, level: 1 };

/** The invented outlook catchment with a river off-take from Farm A to Farm B and a drought restriction on storage only. */
function base(): ModelInput {
	const x = testCatchment();
	const offtake: Transfer = {
		id: 't1', fromNodeId: 'a', toNodeId: 'b', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 0.02, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0,
		...OFFTAKE_DEFAULTS, source: 'river'
	};
	x.model.transfers = [offtake];
	x.settings.droughtRestriction = structuredClone(RESTRICTION);
	return x;
}

/** The same catchment with every EWR-keeping rule switched on, and a set hands-off flow on Farm B that stays. */
function withRules(): ModelInput {
	const x = base();
	const [, a, b] = x.model.nodes;
	a!.damReleaseRule = 'passInflow';
	a!.damReleaseM3Day = null;
	b!.handsOffEwr = true;
	b!.handsOffM3Day = new Array(12).fill(20);
	x.model.transfers[0]!.handsOffEwr = true;
	x.settings.droughtRestriction = { ...structuredClone(RESTRICTION), ewrTrigger: { ...TRIGGER } };
	return x;
}

/** The ops a scenario uses to switch them back on (docs/scenarios.md § The EWR-keeping rules). */
const ON: ScenarioOp[] = [
	{ op: 'node.set', nodeId: 'a', field: 'damReleaseRule', value: 'passInflow' },
	{ op: 'node.set', nodeId: 'b', field: 'handsOffEwr', value: true },
	{ op: 'transfer.set', transferId: 't1', field: 'handsOffEwr', value: true },
	{ op: 'settings.set', path: 'droughtRestriction', value: { ...structuredClone(RESTRICTION), ewrTrigger: { ...TRIGGER } } }
];

const run = (x: ModelInput) => runModelWithoutChecks(structuredClone(x));
const baseline = (x: ModelInput) => withoutEwrKeepingRules(x).project;

describe('withoutEwrKeepingRules', () => {
	it('switches off exactly the four rules, keeps the set flows, and never mutates its input', () => {
		const x = withRules();
		const before = structuredClone(x);
		const { project, removed } = withoutEwrKeepingRules(x);
		expect(x).toEqual(before);
		expect(removed.map((r) => [r.kind, r.id])).toEqual([
			['damPassInflow', 'a'],
			['unitHandsOff', 'b'],
			['offtakeHandsOff', 't1'],
			['restrictionEwrTrigger', null]
		]);
		const [, a, b] = project.model.nodes;
		expect(a!.damReleaseRule).toBe('none');
		expect(b!.handsOffEwr).toBe(false);
		expect(b!.handsOffM3Day).toEqual(new Array(12).fill(20));
		expect(project.model.transfers[0]!.handsOffEwr).toBe(false);
		expect(project.settings.droughtRestriction).toEqual(RESTRICTION);
		// What is left is a set flow, which the baseline keeps; none of it keeps the EWR.
		expect(ewrReleaseRules(project).map((r) => [r.kind, r.target])).toEqual([['unitHandsOff', 'setFlow']]);
		expect(baselineEwrRules(project)).toEqual([]);
	});

	it('leaves a pass-inflow release with amounts and a hands-off flow by month (set flows) alone', () => {
		const x = base();
		x.model.nodes[1]!.damReleaseRule = 'passInflow';
		x.model.nodes[1]!.damReleaseM3Day = new Array(12).fill(50);
		x.model.nodes[2]!.handsOffM3Day = new Array(12).fill(10);
		x.model.transfers[0]!.handsOffM3Day = 30;
		const out = withoutEwrKeepingRules(x);
		expect(out.removed).toEqual([]);
		expect(out.project).toBe(x);
		expect(ewrReleaseRules(x).every((r) => !keepsEwr(r))).toBe(true);
	});

	it('says, for each rule, the scenario op that keeps it', () => {
		const lines = withoutEwrKeepingRules(withRules()).removed.map(scenarioOnlyLine);
		expect(lines[0]).toBe('unit "Farm A": dam release: pass inflow keeps the EWR, which only a scenario may do (node.set damReleaseRule passInflow, with damReleaseM3Day null)');
		expect(lines[3]).toBe('drought restriction rule: drought restriction triggered by an EWR failure keeps the EWR, which only a scenario may do (settings.set droughtRestriction, with an ewrTrigger)');
	});
});

describe('the baseline assesses the EWR and never applies it (issue #523 B4)', () => {
	it('a baseline run is bit-identical with and without the rules stored', () => {
		expectBitIdentical(run(baseline(withRules())), run(baseline(base())), 'outlook catchment');
		// The stored set flow on Farm B is the one difference the baseline keeps: with it in both, they match too.
		const withSetFlow = base();
		withSetFlow.model.nodes[2]!.handsOffM3Day = new Array(12).fill(20);
		expectBitIdentical(run(baseline(withRules())), run(withSetFlow), 'outlook catchment, set flow kept');
	});

	it('positive control: as stored, the rules change the run (the EWR binds)', () => {
		const stored = run(withRules());
		const assessed = run(baseline(withRules()));
		const series = (o: ModelOutput, node: string, key: string) => o.series.find((s) => s.nodeId === node && s.key === key)!.values;
		expect(series(stored, 'a', 'dam_storage'), 'the pass-inflow release draws Farm A’s dam down').not.toEqual(series(assessed, 'a', 'dam_storage'));
		// Each rule on its own: the pass-inflow release and the restriction's EWR trigger both bind here.
		for (const keep of [0, 3]) {
			const x = baseline(withRules());
			const { input, problems } = applyScenario(x, [ON[keep]!]);
			expect(problems).toEqual([]);
			expect(run(input).series, `op ${keep}`).not.toEqual(run(x).series);
		}
	});

	it('a scenario switching them on runs exactly as the stored rules did', () => {
		const { input, problems, applied } = applyScenario(baseline(withRules()), ON);
		expect(problems).toEqual([]);
		expect(applied).toHaveLength(ON.length);
		expect(baselineEwrRules(input)).toHaveLength(4);
		expectBitIdentical(run(input), run(withRules()), 'scenario with the rules');
	});

	it('random networks (the engine fuzz): a baseline keeps no EWR rule and is the same run however many were stored', () => {
		let tried = 0;
		let withAny = 0;
		for (let seed = 1; tried < 40 && seed < 2000; seed++) {
			const x = randomInput(seed, { maxDays: 500 });
			tried++;
			const { project, removed } = withoutEwrKeepingRules(x);
			if (removed.length) withAny++;
			expect(baselineEwrRules(project), `seed ${seed}`).toEqual([]);
			// Idempotent: a baseline already without them is passed through as it is.
			expect(withoutEwrKeepingRules(project).project).toBe(project);
			// The rules switched off by hand (each field as the engine reads it) run the same as the helper's baseline.
			const byHand = structuredClone(x);
			for (const n of byHand.model.nodes) {
				if (n.damReleaseRule === 'passInflow' && !Array.isArray(n.damReleaseM3Day)) n.damReleaseRule = 'none';
				n.handsOffEwr = false;
			}
			for (const t of byHand.model.transfers) t.handsOffEwr = false;
			if (byHand.settings.droughtRestriction) delete byHand.settings.droughtRestriction.ewrTrigger;
			expectBitIdentical(run(project), run(byHand), `seed ${seed}`);
		}
		expect(withAny).toBeGreaterThan(5);
	});
});
