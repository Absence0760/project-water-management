// ewrReleaseRules (issue #507): each of the four rules that move water for
// the EWR is listed once switched on, a default project lists nothing, and a
// rule the run would ignore is listed with the engine's reason.
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, newNetworkNode, OFFTAKE_DEFAULTS, type NetworkNode, type Transfer } from '../project';
import { ewrReleaseRules, type EwrReleaseRulesInput } from './ewrReleaseRules';

function node(id: string, name: string, down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return { ...newNetworkNode(id, 0, down), name, ...over };
}

function transfer(over: Partial<Transfer> = {}): Transfer {
	return { id: 't1', fromNodeId: 'a', toNodeId: 'b', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, ...OFFTAKE_DEFAULTS, ...over };
}

/** Two units with dams above an outlet gauge, every rule at its default. */
function project(): EwrReleaseRulesInput & { settings: ReturnType<typeof defaultProjectSettings> } {
	return {
		model: {
			nodes: [node('a', 'Upper', 'b', { damCapacityM3: 100_000 }), node('b', 'Lower', 'g', { damCapacityM3: 50_000 }), node('g', 'Outlet', null)],
			transfers: [transfer()]
		},
		settings: defaultProjectSettings()
	};
}

const flat = (v: number) => new Array<number>(12).fill(v);

describe('ewrReleaseRules', () => {
	it('lists nothing for a project with every rule at its default (a dam transfer included)', () => {
		expect(ewrReleaseRules(project())).toEqual([]);
		// A bare project.json: no settings, no transfers key.
		expect(ewrReleaseRules({ model: { nodes: project().model.nodes, transfers: [] } })).toEqual([]);
	});

	it('positive control: a project with all four switched on lists all four, in model order', () => {
		const p = project();
		p.model.nodes[0] = { ...p.model.nodes[0]!, damReleaseRule: 'passInflow' };
		p.model.nodes[1] = { ...p.model.nodes[1]!, handsOffEwr: true };
		p.model.transfers[0] = transfer({ source: 'river', handsOffEwr: true });
		p.settings.droughtRestriction = { reviewDates: ['10-01'], levels: [{ belowPct: 0.5, cuts: { crops: 0.2 } }], ewrTrigger: { siteNodeId: null, level: 1 } } as never;
		const rules = ewrReleaseRules(p);
		expect(rules.map((r) => [r.kind, r.id, r.target, r.inert])).toEqual([
			['damPassInflow', 'a', 'ewr', null],
			['unitHandsOff', 'b', 'ewr', null],
			['offtakeHandsOff', 't1', 'ewr', null],
			['restrictionEwrTrigger', null, 'ewr', null]
		]);
	});

	describe('(1) a dam pass-inflow release', () => {
		it('without amounts keeps the EWR required at the node', () => {
			const p = project();
			p.model.nodes[0] = { ...p.model.nodes[0]!, damReleaseRule: 'passInflow', damReleaseM3Day: null };
			const [r] = ewrReleaseRules(p);
			expect(r).toMatchObject({ kind: 'damPassInflow', id: 'a', where: 'unit "Upper"', target: 'ewr', setFlowM3Day: null, inert: null });
			expect(r!.text).toBe('unit "Upper": dam release: pass inflow, keeps the EWR required there');
		});

		it('with monthly amounts keeps a set flow, not the EWR', () => {
			const p = project();
			p.model.nodes[0] = { ...p.model.nodes[0]!, damReleaseRule: 'passInflow', damReleaseM3Day: flat(500) };
			expect(ewrReleaseRules(p)).toMatchObject([{ kind: 'damPassInflow', target: 'setFlow', setFlowM3Day: flat(500), inert: null }]);
		});

		it('a fixed release is not an EWR rule; pass inflow without a dam or with 0 amounts is listed as inert', () => {
			const p = project();
			p.model.nodes[0] = { ...p.model.nodes[0]!, damReleaseRule: 'fixed', damReleaseM3Day: flat(500) };
			expect(ewrReleaseRules(p)).toEqual([]);
			p.model.nodes[0] = { ...p.model.nodes[0]!, damReleaseRule: 'passInflow', damCapacityM3: 0, damReleaseM3Day: null };
			p.model.nodes[1] = { ...p.model.nodes[1]!, damReleaseRule: 'passInflow', damReleaseM3Day: flat(0) };
			expect(ewrReleaseRules(p).map((r) => r.inert)).toEqual(['the unit has no dam (capacity 0)', "every month's amount is 0"]);
		});
	});

	describe('(2) a unit hands-off flow', () => {
		it('keeping the EWR', () => {
			const p = project();
			p.model.nodes[1] = { ...p.model.nodes[1]!, handsOffEwr: true };
			expect(ewrReleaseRules(p)).toMatchObject([{ kind: 'unitHandsOff', id: 'b', where: 'unit "Lower"', target: 'ewr', setFlowM3Day: null, inert: null }]);
		});

		it('a set flow, and the larger of both when the EWR is kept too', () => {
			const p = project();
			const row = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 200, 300];
			p.model.nodes[1] = { ...p.model.nodes[1]!, handsOffM3Day: row };
			expect(ewrReleaseRules(p)).toMatchObject([{ kind: 'unitHandsOff', target: 'setFlow', setFlowM3Day: row, inert: null }]);
			p.model.nodes[1] = { ...p.model.nodes[1]!, handsOffM3Day: row, handsOffEwr: true };
			const [r] = ewrReleaseRules(p);
			expect(r).toMatchObject({ target: 'ewrOrSetFlow', setFlowM3Day: row });
			expect(r!.text).toContain('the larger of the EWR and a set flow of 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 200, 300 m³/day (Oct–Sep)');
		});

		it('0 in every month, or on a gauge, is listed as inert', () => {
			const p = project();
			p.model.nodes[1] = { ...p.model.nodes[1]!, handsOffM3Day: flat(0) };
			p.model.nodes[2] = { ...p.model.nodes[2]!, handsOffEwr: true };
			expect(ewrReleaseRules(p).map((r) => r.inert)).toEqual(["every month's amount is 0", 'only a unit has a hands-off flow, not a gauge']);
		});
	});

	describe('(3) a river off-take hands-off flow', () => {
		it('keeping the EWR at the source, named by its ends', () => {
			const p = project();
			p.model.transfers[0] = transfer({ source: 'river', handsOffEwr: true });
			expect(ewrReleaseRules(p)).toMatchObject([{ kind: 'offtakeHandsOff', id: 't1', where: 'transfer "Upper → Lower"', target: 'ewr', setFlowM3Day: null, inert: null }]);
		});

		it('a set flow', () => {
			const p = project();
			p.model.transfers[0] = transfer({ source: 'river', handsOffM3Day: 2500 });
			expect(ewrReleaseRules(p)).toMatchObject([{ target: 'setFlow', setFlowM3Day: 2500, inert: null, text: 'transfer "Upper → Lower": hands-off flow at a river off-take, keeps a set flow of 2500 m³/day' }]);
		});

		it('on a dam transfer, or a switched-off off-take, is listed as inert', () => {
			const p = project();
			p.model.transfers = [transfer({ id: 'd', handsOffEwr: true }), transfer({ id: 'off', source: 'river', handsOffEwr: true, enabled: false })];
			expect(ewrReleaseRules(p).map((r) => [r.id, r.inert])).toEqual([
				['d', 'a dam transfer: the hands-off fields apply to a river off-take only'],
				['off', 'the transfer is switched off']
			]);
		});
	});

	describe('(4) a drought restriction triggered by an EWR failure', () => {
		const levels = [{ belowPct: 0.5, cuts: { crops: 0.2 } }];

		it('a restriction on storage alone is not an EWR rule', () => {
			const p = project();
			p.settings.droughtRestriction = { reviewDates: ['10-01'], levels } as never;
			expect(ewrReleaseRules(p)).toEqual([]);
		});

		it('with an EWR trigger at a gauge', () => {
			const p = project();
			p.settings.droughtRestriction = { reviewDates: ['10-01'], levels, ewrTrigger: { siteNodeId: 'g', level: 1 } } as never;
			expect(ewrReleaseRules(p)).toMatchObject([
				{ kind: 'restrictionEwrTrigger', id: null, target: 'ewr', inert: null, text: `drought restriction rule: drought restriction triggered by an EWR failure, at least level 1 on a review day after the EWR at "Outlet" wasn't met` }
			]);
		});

		it('at a site that is not an EWR gauge is listed as inert', () => {
			const p = project();
			p.model.nodes[2] = { ...p.model.nodes[2]!, ewrSite: false };
			p.settings.droughtRestriction = { reviewDates: ['10-01'], levels, ewrTrigger: { siteNodeId: 'g', level: 1 } } as never;
			expect(ewrReleaseRules(p)[0]!.inert).toBe(`"Outlet" isn't an EWR site`);
			p.settings.droughtRestriction = { reviewDates: ['10-01'], levels, ewrTrigger: { siteNodeId: 'gone', level: 1 } } as never;
			expect(ewrReleaseRules(p)[0]!.inert).toBe("its EWR site gone isn't in the model");
		});
	});
});
