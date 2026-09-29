// The model document's structural save rules: what zod's field ranges can't
// express. The one home for them (docs/scenarios.md, followups "One home for
// the model's save rules"): the backend refuses a save or an import that
// breaks one (backend/src/model/validate.ts modelProblems), and applyScenario
// refuses an op that introduces one (scenario/structure.ts). Keeping both on
// this function means a scenario can only produce a model the backend would
// accept as a save, and a rule added here reaches both.
import { SUPPLY_DEFAULTS, type ProjectModel } from './project';
import { damCurveProblem } from './network/damCurve';
import { developmentProblem } from './network/development';
import { monthlyRatesMismatch } from './network/transferRates';
import { isRiverOfftake } from './network/offtake';
import { DEMAND_SCHEDULE_MAX_WINDOWS, scheduleWindowProblem } from './network/demandSchedule';

/**
 * Every rule a model breaks, keyed by what breaks it (ids, not names, so
 * renaming a node doesn't turn an old issue into a new one) → a sentence for
 * people. Empty means the model is valid.
 */
export function modelRuleIssues(m: ProjectModel): Map<string, string> {
	const out = new Map<string, string>();
	const add = (key: string, text: string) => {
		if (!out.has(key)) out.set(key, text);
	};
	const byId = new Map(m.nodes.map((n) => [n.id, n]));
	const cropIds = new Set(m.crops.map((c) => c.id));

	const dupes = (kind: string, xs: string[], show: (x: string) => string = (x) => x) => {
		const seen = new Set<string>();
		for (const x of xs) {
			if (seen.has(x)) add(`dup:${kind}:${x}`, `duplicate ${kind} ${show(x)}`);
			seen.add(x);
		}
	};
	// Names compare case-insensitively (run comparison matches copies by name).
	dupes('node id', m.nodes.map((n) => n.id));
	dupes('node name', m.nodes.map((n) => n.name.trim().toLowerCase()), (x) => `"${x}"`);
	dupes('crop id', m.crops.map((c) => c.id));
	dupes('crop name', m.crops.map((c) => c.name.trim().toLowerCase()), (x) => `"${x}"`);
	dupes('transfer id', m.transfers.map((t) => t.id));
	dupes('crop area', m.cropAreas.map((a) => `${a.nodeId}/${a.cropId}`));
	dupes('land-cover id', (m.landCover ?? []).map((p) => p.id));

	for (const p of m.landCover ?? []) {
		const n = byId.get(p.nodeId);
		if (!n) add(`lcNode:${p.id}`, `land cover ${p.id} references an unknown node`);
		else if (n.kind !== 'farm')
			add(`lcKind:${p.id}`, `land cover on "${n.name}": land cover lies on a farm (a hydrological unit), not a ${n.kind === 'user' ? 'user' : 'gauge'}`);
	}
	// Individual boreholes (WP-3.9): on a farm or other user; emergency mode and pumping into the dam need a farm dam.
	dupes('borehole id', (m.boreholes ?? []).map((b) => b.id));
	for (const b of m.boreholes ?? []) {
		const n = byId.get(b.nodeId);
		if (!n) add(`bhNode:${b.id}`, `borehole ${b.id} references an unknown node`);
		else if (n.kind === 'gauge') add(`bhGauge:${b.id}`, `borehole "${b.name}" is on gauge "${n.name}": a gauge can't have boreholes`);
		else if (b.mode !== 'none' && !(n.kind === 'farm' && n.damCapacityM3 > 0)) {
			if (b.mode === 'emergency') add(`bhEmergency:${b.id}`, `borehole "${b.name}" on "${n.name}": emergency mode needs a farm dam to trigger on`);
			if (b.target === 'dam') add(`bhDam:${b.id}`, `borehole "${b.name}" on "${n.name}": it pumps into a dam, and there is none`);
		}
	}
	// Demand objects (engine ≥ 1.7.0, issue #54 item 2b): on a unit (a farm node), sized the way they say, and nothing returns from one piped out.
	dupes('demand object id', (m.demandObjects ?? []).map((o) => o.id));
	for (const o of m.demandObjects ?? []) {
		const n = byId.get(o.nodeId);
		if (!n) add(`doNode:${o.id}`, `demand object ${o.id} references an unknown node`);
		else if (n.kind !== 'farm') add(`doKind:${o.id}`, `demand object "${o.name}" is on ${n.kind === 'user' ? 'other water user' : 'gauge'} "${n.name}": only a unit has demand objects`);
		if (o.sizing === 'monthly' && !(Array.isArray(o.monthlyM3Day) && o.monthlyM3Day.length === 12))
			add(`doMonthly:${o.id}`, `demand object "${o.name}": a monthly demand needs 12 values (m³/day, Oct–Sep)`);
		if (o.sizing === 'perUnit' && (o.count === null || o.count === undefined || o.litresPerUnitDay === null || o.litresPerUnitDay === undefined))
			add(`doPerUnit:${o.id}`, `demand object "${o.name}": a demand per unit needs a count and litres per unit per day`);
		if (o.destination === 'external' && o.returnPct > 0) add(`doExternal:${o.id}`, `demand object "${o.name}" is piped out of the catchment, so nothing returns from it; set its return share to 0`);
		// Its schedule (engine ≥ 1.17.0): each window runs as entered, and not too many of them.
		if (Array.isArray(o.schedule)) {
			if (o.schedule.length > DEMAND_SCHEDULE_MAX_WINDOWS) add(`doScheduleCount:${o.id}`, `demand object "${o.name}": its schedule has ${o.schedule.length} windows, at most ${DEMAND_SCHEDULE_MAX_WINDOWS}`);
			o.schedule.forEach((w, i) => {
				const bad = scheduleWindowProblem(w);
				if (bad) add(`doSchedule:${o.id}:${i}`, `demand object "${o.name}": schedule window ${i + 1}${w.label ? ` ("${w.label}")` : ''}: ${bad}`);
			});
		}
	}
	for (const n of m.nodes) {
		if (n.downstreamNodeId && !byId.has(n.downstreamNodeId)) add(`down:${n.id}`, `"${n.name}" drains into an unknown node`);
		// Boreholes (WP-1.34): a gauge only measures; the drought rule triggers on a dam.
		if ((n.boreholeCapacityM3Day ?? 0) > 0 && n.kind === 'gauge') add(`bhGauge:${n.id}`, `gauge "${n.name}" can't have boreholes`);
		if ((n.boreholeCapacityM3Day ?? 0) > 0 && n.boreholeRule === 'drought' && !(n.kind === 'farm' && n.damCapacityM3 > 0))
			add(`bhDrought:${n.id}`, `"${n.name}": the drought borehole rule needs a farm dam to trigger on`);
		if (n.downstreamNodeId === n.id) add(`self:${n.id}`, `"${n.name}" drains into itself`);
		// EWR sites (engine ≥ 1.5.0): the outlet always is one; only another gauge can be taken off the list.
		if (n.ewrSite === false) {
			if (n.downstreamNodeId === null) add(`ewrSiteOutlet:${n.id}`, `"${n.name}" is the outlet, which is always an EWR site`);
			else if (n.kind !== 'gauge') add(`ewrSiteKind:${n.id}`, `"${n.name}": only a gauge can be taken off the EWR sites`);
		}
		// Supply rule and river pump (WP-3.8): a farm's; trigger switches on a dam; run of river has none.
		const supply = n.supplyRule ?? 'damFirst';
		if (n.kind !== 'farm' && (supply !== 'damFirst' || (n.pumpCapacityM3Day !== null && n.pumpCapacityM3Day !== undefined)))
			add(`supplyKind:${n.id}`, `"${n.name}": only a farm has a supply rule and river pump`);
		else if (supply === 'trigger' && !(n.damCapacityM3 > 0)) add(`supplyTrigger:${n.id}`, `"${n.name}": the trigger supply rule needs a farm dam to switch on`);
		else if (supply === 'runOfRiver' && n.damCapacityM3 > 0) add(`supplyRor:${n.id}`, `"${n.name}": run of river has no dam; set the dam capacity to 0 or pick another supply rule`);
		if (n.kind === 'farm' && supply === 'trigger' && (n.supplyStopPct ?? SUPPLY_DEFAULTS.supplyStopPct) < (n.supplyTriggerPct ?? SUPPLY_DEFAULTS.supplyTriggerPct))
			add(`supplyStop:${n.id}`, `"${n.name}": the supply rule's stop level must be at least its trigger level`);
		// Dam survey curve (WP-3.5): only a farm has a dam, and the curve must be one the run can use.
		if (n.damCurve && n.damCurve.length) {
			const bad = n.kind === 'farm' ? damCurveProblem(n.damCurve) : `only a farm has a dam`;
			if (bad) add(`damCurve:${n.id}`, `"${n.name}": dam survey curve: ${bad}`);
		}
		// Development over the run (engine ≥ 1.28.0): the sediment rate, its survey date and the dates read.
		const dev = developmentProblem(n);
		if (dev) add(`development:${n.id}`, `"${n.name}": ${dev}`);
	}
	for (const a of m.cropAreas) {
		const n = byId.get(a.nodeId);
		if (!n) add(`caNode:${a.nodeId}/${a.cropId}`, `crop area references unknown node ${a.nodeId}`);
		else if (n.kind === 'user') add(`caUser:${a.nodeId}`, `crop area on other water user "${n.name}": a user's demand is its monthly demand, not crops`);
		if (!cropIds.has(a.cropId)) add(`caCrop:${a.nodeId}/${a.cropId}`, `crop area references unknown crop ${a.cropId}`);
	}
	for (const t of m.transfers) {
		if (!byId.has(t.fromNodeId) || !byId.has(t.toNodeId)) add(`trNode:${t.id}`, `transfer ${t.id} references an unknown node`);
		// A user has no dam to send from or fill (WP-1.33).
		if (byId.get(t.fromNodeId)?.kind === 'user' || byId.get(t.toNodeId)?.kind === 'user')
			add(`trUser:${t.id}`, `transfer ${t.id} involves an other water user: transfers run between farm dams`);
		if (t.fromNodeId === t.toNodeId) add(`trSelf:${t.id}`, `transfer ${t.id} goes from a node to itself`);
		// Monthly rates (engine ≥ 1.14.0): what runs, so the months and max rate kept beside them must agree.
		const monthly = monthlyRatesMismatch(t);
		if (monthly) add(`trMonthly:${t.id}`, `transfer ${t.id}: ${monthly}`);
		// River off-takes (engine ≥ 1.14.0): from one unit to another, the destination not draining into the
		// source (the engine simulates the destination after its source), losses below 100 %.
		if (isRiverOfftake(t)) {
			const a = byId.get(t.fromNodeId);
			const b = byId.get(t.toNodeId);
			if (a && b && (a.kind !== 'farm' || b.kind !== 'farm')) add(`trRiverKind:${t.id}`, `river off-take ${t.id}: it runs from one unit to another, not from or to a ${a.kind !== 'farm' ? a.kind : b.kind}`);
			else if (t.enabled && a && b && a !== b && drainsInto(m, b.id, a.id, t.id)) add(`trRiverLoop:${t.id}`, `river off-take "${a.name}" → "${b.name}": its destination drains into its source (along the river or through other off-takes), so it would take water before it arrives`);
			const loss = t.lossPct ?? 0;
			if (!(loss >= 0 && loss < 1)) add(`trRiverLoss:${t.id}`, `river off-take ${t.id}: conveyance losses must be at least 0 % and below 100 %`);
		}
	}

	if (m.nodes.length) {
		const outlets = m.nodes.filter((n) => n.downstreamNodeId === null);
		if (outlets.length !== 1) add('outlets', `the network needs exactly one outflow node (drains into nothing); found ${outlets.length}`);
		// Cycle check: follow downstream pointers from each node.
		const next = new Map(m.nodes.map((n) => [n.id, n.downstreamNodeId]));
		for (const n of m.nodes) {
			const seen = new Set<string>();
			let cur: string | null | undefined = n.id;
			while (cur) {
				if (seen.has(cur)) {
					add(`loop:${n.id}`, `the network has a loop through "${n.name}"`);
					break;
				}
				seen.add(cur);
				cur = next.get(cur);
			}
		}
	}
	return out;
}

/**
 * Does water at node `from` reach node `to`, down the river or through the
 * model's other enabled river off-takes (not `except`)?
 */
function drainsInto(m: ProjectModel, from: string, to: string, except: string): boolean {
	const next = new Map<string, string[]>(m.nodes.map((n) => [n.id, n.downstreamNodeId ? [n.downstreamNodeId] : []]));
	for (const t of m.transfers) if (t.enabled && isRiverOfftake(t) && t.id !== except) next.get(t.fromNodeId)?.push(t.toNodeId);
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length) {
		const cur = stack.pop()!;
		if (cur === to) return true;
		if (seen.has(cur)) continue;
		seen.add(cur);
		stack.push(...(next.get(cur) ?? []));
	}
	return false;
}

/** The model's broken rules as distinct sentences (empty = valid): what a save or an import is refused with. */
export const modelRuleProblems = (m: ProjectModel): string[] => [...new Set(modelRuleIssues(m).values())];
