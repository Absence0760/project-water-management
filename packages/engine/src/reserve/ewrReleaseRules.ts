// The rules that move water for the EWR, as a project stores them (issue
// #507). A run keeps water in the river for the Ecological Reserve only
// through four rules, all off by default and never switched on by an
// importer: a dam's pass-inflow release (network/dam.ts), a unit's hands-off
// flow (network/supply.ts), a river off-take's hands-off flow
// (network/offtake.ts) and the drought restriction rule's EWR trigger
// (network/restriction.ts). Everything else only *reports* the EWR. This
// lists every one of them a project has switched on, so an operator can tell
// whether a baseline run releases anything for the EWR without reading the
// model by hand (`pnpm list:ewr-rules <project.json>`, docs/run-locally.md
// § Which rules keep water for the EWR). Pure: reads the model and settings,
// runs nothing; never part of a run, so not a model change.
import type { DroughtRestrictionRule, NetworkNode, ProjectModel, Transfer } from '../project';
import { isRiverOfftake } from '../network/offtake';

export const EWR_RELEASE_RULE_KINDS = ['damPassInflow', 'unitHandsOff', 'offtakeHandsOff', 'restrictionEwrTrigger'] as const;
export type EwrReleaseRuleKind = (typeof EWR_RELEASE_RULE_KINDS)[number];

/** Each kind in plain words. */
export const EWR_RELEASE_RULE_LABEL: Record<EwrReleaseRuleKind, string> = {
	damPassInflow: 'dam release: pass inflow',
	unitHandsOff: 'hands-off flow at a unit',
	offtakeHandsOff: 'hands-off flow at a river off-take',
	restrictionEwrTrigger: 'drought restriction triggered by an EWR failure'
};

/**
 * What a rule keeps in the river: the EWR required at its place (its own and
 * upstream shares, the cumulative Z), a set flow, or the larger of the two
 * each day. The restriction's trigger is 'ewr': it reads whether the EWR at
 * its site was met.
 */
export type EwrReleaseTarget = 'ewr' | 'setFlow' | 'ewrOrSetFlow';

export interface EwrReleaseRule {
	kind: EwrReleaseRuleKind;
	/** The node's or the transfer's id; null for the drought restriction rule (a project setting). */
	id: string | null;
	/** Where: the unit's name, "from → to" for an off-take, or "drought restriction rule". */
	where: string;
	target: EwrReleaseTarget;
	/**
	 * The set flow (m³/day): 12 water-year months (Oct–Sep) for a dam or a
	 * unit, one value for an off-take; null when the target is the EWR alone.
	 */
	setFlowM3Day: number[] | number | null;
	/** Why a run ignores the rule as stored (the engine's own reason), or null when it runs. */
	inert: string | null;
	/** One line for people. */
	text: string;
}

/** The project parts the rules live in: any ProjectFile / project.json has both. */
export interface EwrReleaseRulesInput {
	model: Pick<ProjectModel, 'nodes' | 'transfers'>;
	settings?: { droughtRestriction?: DroughtRestrictionRule | null } | null;
}

const nameOf = (n: Pick<NetworkNode, 'id' | 'name'> | undefined, id: string): string => (n?.name?.trim() ? n.name.trim() : id);
const positive = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x > 0;
const monthly = (row: unknown): number[] | null => (Array.isArray(row) ? row.map((v) => Number(v)) : null);
const flowWords = (f: number[] | number): string => (Array.isArray(f) ? `${f.join(', ')} m³/day (Oct–Sep)` : `${f} m³/day`);

function sentence(r: Omit<EwrReleaseRule, 'text'>, extra = ''): string {
	const keeps =
		r.target === 'ewr' ? 'the EWR required there' : r.target === 'setFlow' ? `a set flow of ${flowWords(r.setFlowM3Day!)}` : `the larger of the EWR and a set flow of ${flowWords(r.setFlowM3Day!)}`;
	const what = r.kind === 'restrictionEwrTrigger' ? extra : `keeps ${keeps}${extra}`;
	return `${r.where}: ${EWR_RELEASE_RULE_LABEL[r.kind]}, ${what}${r.inert ? ` (inert: ${r.inert})` : ''}`;
}

function push(out: EwrReleaseRule[], r: Omit<EwrReleaseRule, 'text'>, extra = ''): void {
	out.push({ ...r, text: sentence(r, extra) });
}

/**
 * Every rule that moves water for the EWR that the project switches on, in
 * model order (nodes, then transfers, then the settings rule). Empty = a run
 * keeps nothing in the river for the EWR beyond what flows there anyway. A
 * rule switched on in a way the run ignores (on a node without a dam, on a
 * dam transfer, a switched-off transfer, amounts of 0 in every month) is
 * still listed, with `inert` saying why, since one edit makes it run.
 */
export function ewrReleaseRules(project: EwrReleaseRulesInput): EwrReleaseRule[] {
	const out: EwrReleaseRule[] = [];
	const nodes = project.model.nodes ?? [];
	const byId = new Map(nodes.map((n) => [n.id, n]));

	for (const n of nodes) {
		const where = `unit "${nameOf(n, n.id)}"`;
		// (1) Pass inflow (dam.ts resolveRelease): no amounts → the EWR required at the node.
		if (n.damReleaseRule === 'passInflow') {
			const amounts = monthly(n.damReleaseM3Day);
			const inert =
				n.kind !== 'farm' ? `a ${n.kind} has no dam to release from` : !(n.damCapacityM3 > 0) ? 'the unit has no dam (capacity 0)' : amounts && !amounts.some(positive) ? "every month's amount is 0" : null;
			push(out, { kind: 'damPassInflow', id: n.id, where, target: amounts ? 'setFlow' : 'ewr', setFlowM3Day: amounts, inert });
		}
		// (2) Hands-off flow (supply.ts operatingOf): MAX(the month's amount, the EWR when kept).
		const handsOff = monthly(n.handsOffM3Day);
		const keepsEwr = n.handsOffEwr === true;
		if (keepsEwr || handsOff) {
			const flows = handsOff && handsOff.some(positive) ? handsOff : null;
			const inert = n.kind !== 'farm' ? `only a unit has a hands-off flow, not a ${n.kind}` : !keepsEwr && !flows ? "every month's amount is 0" : null;
			const target: EwrReleaseTarget = keepsEwr ? (flows ? 'ewrOrSetFlow' : 'ewr') : 'setFlow';
			push(out, { kind: 'unitHandsOff', id: n.id, where, target, setFlowM3Day: keepsEwr && !flows ? null : handsOff, inert });
		}
	}

	// (3) A river off-take's hands-off flow (offtake.ts offtakeOf): MAX(the flow, the EWR at the source when kept).
	for (const tr of (project.model.transfers ?? []) as Transfer[]) {
		const flow = positive(tr.handsOffM3Day) ? (tr.handsOffM3Day as number) : null;
		const keepsEwr = tr.handsOffEwr === true;
		if (!flow && !keepsEwr) continue;
		const where = `transfer "${nameOf(byId.get(tr.fromNodeId), tr.fromNodeId)} → ${nameOf(byId.get(tr.toNodeId), tr.toNodeId)}"`;
		const inert = !isRiverOfftake(tr) ? 'a dam transfer: the hands-off fields apply to a river off-take only' : tr.enabled === false ? 'the transfer is switched off' : null;
		push(out, { kind: 'offtakeHandsOff', id: tr.id, where, target: keepsEwr ? (flow ? 'ewrOrSetFlow' : 'ewr') : 'setFlow', setFlowM3Day: flow, inert });
	}

	// (4) The drought restriction's EWR trigger (restriction.ts): a site that isn't an EWR gauge is left out.
	const rule = project.settings?.droughtRestriction;
	if (rule?.ewrTrigger) {
		const { siteNodeId, level } = rule.ewrTrigger;
		const site = siteNodeId === null ? undefined : byId.get(siteNodeId);
		const siteWords = siteNodeId === null ? 'the outlet' : `"${nameOf(site, siteNodeId)}"`;
		const inert = siteNodeId === null ? null : !site ? `its EWR site ${siteNodeId} isn't in the model` : site.kind !== 'gauge' || site.ewrSite === false ? `${siteWords} isn't an EWR site` : null;
		push(out, { kind: 'restrictionEwrTrigger', id: null, where: 'drought restriction rule', target: 'ewr', setFlowM3Day: null, inert }, `at least level ${level} on a review day after the EWR at ${siteWords} wasn't met`);
	}
	return out;
}
