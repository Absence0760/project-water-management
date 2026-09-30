// The model's save rules (modelRules.ts) are the one home the backend's
// modelProblems and applyScenario share. The rules themselves are tested
// through the backend (backend/src/model/validate.test.ts) and the scenario
// ops (scenario/overrides.test.ts); here, what sharing them promises: a
// scenario applied to a valid model never produces a model a save would
// refuse.
import { describe, expect, it } from 'vitest';
import { modelRuleIssues, modelRuleProblems } from './modelRules';
import { randomInput } from './testing/fuzz';
import { randomOps } from './testing/scenarioFuzz';
import { applyScenario } from './scenario/overrides';
import type { ProjectModel } from './project';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const CASES = Number(env.SCENARIO_FUZZ_CASES ?? 300);

describe('modelRuleIssues', () => {
	it('keys each broken rule by ids, and lists each sentence once', () => {
		const n = (id: string, name: string, downstreamNodeId: string | null) => ({ id, name, kind: 'farm', downstreamNodeId }) as ProjectModel['nodes'][number];
		const m = { nodes: [n('g', 'Gauge', null), n('a', 'Farm', 'g'), n('b', ' farm ', 'g'), n('c', 'Other', null)], crops: [], cropAreas: [], transfers: [] } as unknown as ProjectModel;
		const issues = modelRuleIssues(m);
		expect([...issues.keys()].sort()).toEqual(['dup:node name:farm', 'outlets']);
		expect(modelRuleProblems(m)).toEqual(['duplicate node name "farm"', 'the network needs exactly one outflow node (drains into nothing); found 2']);
	});

	it('individual boreholes (WP-3.9): on a farm or user, and emergency mode or pumping into a dam only on a farm with a dam', () => {
		const n = (id: string, kind: string, damCapacityM3: number, downstreamNodeId: string | null) => ({ id, name: id, kind, damCapacityM3, downstreamNodeId }) as ProjectModel['nodes'][number];
		const b = (id: string, nodeId: string, over: object = {}) => ({ id, nodeId, name: id, capacityM3Day: 1, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0, ...over });
		const m = {
			nodes: [n('g', 'gauge', 0, null), n('dam', 'farm', 100, 'g'), n('dry', 'farm', 0, 'g')],
			crops: [],
			cropAreas: [],
			transfers: [],
			boreholes: [b('ok', 'dam', { mode: 'emergency', target: 'dam' }), b('ok2', 'dry'), b('off', 'dry', { mode: 'none', target: 'dam' }), b('x', 'g'), b('y', 'zz'), b('e', 'dry', { mode: 'emergency' }), b('d', 'dry', { target: 'dam' }), b('ok', 'dam')]
		} as unknown as ProjectModel;
		expect([...modelRuleIssues(m).keys()].sort()).toEqual(['bhDam:d', 'bhEmergency:e', 'bhGauge:x', 'bhNode:y', 'dup:borehole id:ok']);
	});

	it('monthly transfer rates (engine 1.14.0): the months and max rate kept beside them must agree with them', () => {
		const n = (id: string, downstreamNodeId: string | null) => ({ id, name: id, kind: 'farm', damCapacityM3: 0, downstreamNodeId }) as ProjectModel['nodes'][number];
		const t = (id: string, over: object) => ({ id, fromNodeId: 'a', toNodeId: 'b', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, ...over });
		const rates = [0, 0, 0, 0.5, 0.2, 0, 0, 0, 0, 0, 0, 0];
		const m = {
			nodes: [n('b', null), n('a', 'b')],
			crops: [],
			cropAreas: [],
			transfers: [t('ok', { monthlyRateM3s: rates, months: [1, 2], maxRateM3s: 0.5 }), t('none', {}), t('months', { monthlyRateM3s: rates, months: [1], maxRateM3s: 0.5 }), t('max', { monthlyRateM3s: rates, months: [1, 2], maxRateM3s: 1 }), t('short', { monthlyRateM3s: [1] })]
		} as unknown as ProjectModel;
		expect([...modelRuleIssues(m).keys()].sort()).toEqual(['trMonthly:max', 'trMonthly:months', 'trMonthly:short']);
	});

	it('river off-takes (engine 1.14.0): unit to unit, the destination not draining into the source, losses below 100 %', () => {
		const n = (id: string, kind: string, downstreamNodeId: string | null) => ({ id, name: id, kind, damCapacityM3: 0, downstreamNodeId }) as ProjectModel['nodes'][number];
		const t = (id: string, fromNodeId: string, toNodeId: string, over: object = {}) => ({ id, fromNodeId, toNodeId, months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, source: 'river', ...over });
		// g <- up <- mid; canal -> town -> g.
		const nodes = [n('g', 'gauge', null), n('up', 'farm', 'g'), n('mid', 'farm', 'up'), n('canal', 'farm', 'town'), n('town', 'farm', 'g')];
		const issues = (transfers: object[]) => [...modelRuleIssues({ nodes, crops: [], cropAreas: [], transfers } as unknown as ProjectModel).keys()].filter((k) => k.startsWith('trRiver')).sort();
		expect(
			issues([
				t('ok', 'up', 'canal'),
				t('gauge', 'up', 'g'),
				t('loop', 'up', 'mid'),
				t('offLoop', 'up', 'mid', { enabled: false }),
				t('loss', 'up', 'town', { lossPct: 1 }),
				t('dam', 'up', 'mid', { source: 'dam' })
			])
		).toEqual(['trRiverKind:gauge', 'trRiverLoop:loop', 'trRiverLoss:loss']);
		// A loop through another off-take: up -> canal, canal drains to town, town -> mid, mid drains to up.
		expect(issues([t('ok', 'up', 'canal'), t('chain', 'town', 'mid')])).toEqual(['trRiverLoop:chain', 'trRiverLoop:ok']);
	});

	it('demand objects (engine 1.7.0): on a unit, sized the way they say, nothing back from water piped out', () => {
		const n = (id: string, kind: string, downstreamNodeId: string | null) => ({ id, name: id, kind, damCapacityM3: 0, downstreamNodeId }) as ProjectModel['nodes'][number];
		const o = (id: string, nodeId: string, over: object = {}) => ({
			id,
			nodeId,
			name: id,
			category: 'other',
			sizing: 'monthly',
			monthlyM3Day: new Array(12).fill(1),
			count: null,
			litresPerUnitDay: null,
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0,
			priority: 'shared',
			destination: 'internal',
			enabled: true,
			note: '',
			...over
		});
		const win = (over: object = {}) => ({ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: null, factor: 0, ...over });
		const m = {
			nodes: [n('g', 'gauge', null), n('f', 'farm', 'g'), n('u', 'user', 'g')],
			crops: [],
			cropAreas: [],
			transfers: [],
			demandObjects: [
				o('ok', 'f'),
				o('ok2', 'f', { sizing: 'perUnit', monthlyM3Day: null, count: 10, litresPerUnitDay: 25 }),
				o('ok', 'f'),
				o('onUser', 'u'),
				o('onGauge', 'g'),
				o('lost', 'zz'),
				o('short', 'f', { monthlyM3Day: [1, 2] }),
				o('noCount', 'f', { sizing: 'perUnit', monthlyM3Day: null }),
				o('ext', 'f', { destination: 'external', returnPct: 0.3 }),
				// A schedule (engine 1.17.0): one good window and one bad; and one with too many windows.
				o('sched', 'f', { schedule: [win({ weekdays: [6, 7] }), win({ span: 'yearly', from: '12-01', to: null })] }),
				o('many', 'f', { schedule: Array.from({ length: 25 }, () => win()) }),
				// The people it serves (engine 1.41.0): a number ≥ 0 or none.
				o('people', 'f', { category: 'municipal', population: 2000 }),
				o('noPeople', 'f', { category: 'municipal', population: -3 })
			]
		} as unknown as ProjectModel;
		expect([...modelRuleIssues(m).keys()].sort()).toEqual(['doExternal:ext', 'doKind:onGauge', 'doKind:onUser', 'doMonthly:short', 'doNode:lost', 'doPerUnit:noCount', 'doPopulation:noPeople', 'doSchedule:sched:1', 'doScheduleCount:many', 'dup:demand object id:ok']);
	});

	it('supply rules (WP-3.8): a farm’s; trigger needs a dam; run of river has none; stop ≥ trigger', () => {
		const n = (id: string, kind: string, damCapacityM3: number, over: object = {}) => ({ id, name: id, kind, damCapacityM3, downstreamNodeId: id === 'g' ? null : 'g', ...over }) as ProjectModel['nodes'][number];
		const m = {
			nodes: [
				n('g', 'gauge', 0),
				n('ok1', 'farm', 100, { supplyRule: 'trigger', supplyTriggerPct: 0.3, supplyStopPct: 0.3 }),
				n('ok2', 'farm', 0, { supplyRule: 'runOfRiver', pumpCapacityM3Day: 10 }),
				n('ok3', 'farm', 100, { supplyRule: 'riverFirst', pumpCapacityM3Day: null }),
				n('ok4', 'user', 0, { supplyRule: 'damFirst', pumpCapacityM3Day: null }),
				n('u', 'user', 0, { pumpCapacityM3Day: 5 }),
				n('t', 'farm', 0, { supplyRule: 'trigger' }),
				n('r', 'farm', 100, { supplyRule: 'runOfRiver' }),
				n('s', 'farm', 100, { supplyRule: 'trigger', supplyTriggerPct: 0.5, supplyStopPct: 0.4 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		} as unknown as ProjectModel;
		expect([...modelRuleIssues(m).keys()].sort()).toEqual(['supplyKind:u', 'supplyRor:r', 'supplyStop:s', 'supplyTrigger:t']);
	});

	it('hands-off flow and River to dam by month (engine 1.32.0): a farm\'s, 12 values each', () => {
		const n = (id: string, kind: string, over: object = {}) => ({ id, name: id, kind, damCapacityM3: 0, downstreamNodeId: id === 'g' ? null : 'g', ...over }) as ProjectModel['nodes'][number];
		const twelve = new Array(12).fill(100);
		const m = {
			nodes: [
				n('g', 'gauge', { handsOffEwr: false, handsOffM3Day: null, divertMonthlyM3Day: null }),
				n('ok', 'farm', { handsOffM3Day: twelve, handsOffEwr: true, divertMonthlyM3Day: twelve }),
				n('u', 'user', { handsOffEwr: true }),
				n('h', 'farm', { handsOffM3Day: [1, 2] }),
				n('d', 'farm', { divertMonthlyM3Day: new Array(13).fill(0) })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		} as unknown as ProjectModel;
		expect([...modelRuleIssues(m).keys()].sort()).toEqual(['divertMonths:d', 'handsOffMonths:h', 'operatingKind:u']);
	});

	it('a scenario applied to a valid model leaves a model the backend would save', () => {
		let checked = 0;
		for (let seed = 1; checked < CASES && seed < CASES * 4; seed++) {
			const base = randomInput(seed, { maxNodes: 12, maxDays: 60 });
			// Only bases a save would accept (the fuzz also makes deliberately odd ones).
			if (modelRuleIssues(base.model).size) continue;
			const { input } = applyScenario(base, randomOps(base, seed));
			expect(modelRuleProblems(input.model), `seed ${seed}`).toEqual([]);
			checked++;
		}
		expect(checked).toBeGreaterThan(CASES / 2);
	});
});
