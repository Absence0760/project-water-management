// The model document's structural save rules: what zod's field ranges can't
// express. The one home for them (docs/scenarios.md, followups "One home for
// the model's save rules"): the backend refuses a save or an import that
// breaks one (backend/src/model/validate.ts modelProblems), and applyScenario
// refuses an op that introduces one (scenario/structure.ts). Keeping both on
// this function means a scenario can only produce a model the backend would
// accept as a save, and a rule added here reaches both.
import { DEMAND_OBJECT_MAX_RANK, DEMAND_OBJECT_SOURCE_SIZING, DEMAND_OBJECT_SOURCES, SUPPLY_DEFAULTS, WATER_SOURCES, type ProjectModel } from './project';
import { damCurveProblem } from './network/damCurve';
import { cropSupplyIssues } from './network/cropSupply';
import { developmentProblem } from './network/development';
import { monthlyRatesMismatch } from './network/transferRates';
import { isRiverOfftake, offtakeReturnAt } from './network/offtake';
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
			add(`lcKind:${p.id}`, `land cover on "${n.name}": land cover lies on a unit, not a ${n.kind === 'user' ? 'user' : 'gauge'}`);
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
		// The people it serves, for the basic-needs floor (engine ≥ 1.44.0): a number ≥ 0, or none.
		if (o.population !== null && o.population !== undefined && !(typeof o.population === 'number' && Number.isFinite(o.population) && o.population >= 0))
			add(`doPopulation:${o.id}`, `demand object "${o.name}": the people it serves must be a number ≥ 0`);
		// Its rank within its priority class (engine ≥ 1.64.0): a whole number from 1 to DEMAND_OBJECT_MAX_RANK, or none (1).
		if (o.rank !== null && o.rank !== undefined && !(Number.isInteger(o.rank) && o.rank >= 1 && o.rank <= DEMAND_OBJECT_MAX_RANK))
			add(`doRank:${o.id}`, `demand object "${o.name}": its rank must be a whole number from 1 to ${DEMAND_OBJECT_MAX_RANK}`);
		// Where its number comes from (engine ≥ 1.56.0): one of the sources, sized the way that source gives a volume.
		if (o.source !== null && o.source !== undefined) {
			if (!(DEMAND_OBJECT_SOURCES as readonly unknown[]).includes(o.source))
				add(`doSource:${o.id}`, `demand object "${o.name}": its source must be one of ${DEMAND_OBJECT_SOURCES.join(', ')}`);
			else {
				const sizing = DEMAND_OBJECT_SOURCE_SIZING[o.source];
				if (sizing !== null && o.sizing !== sizing)
					add(
						`doSourceSizing:${o.id}`,
						sizing === 'monthly'
							? `demand object "${o.name}": ${o.source === 'meter' ? 'a meter record' : 'an AADD'} is a volume, so size it by month (m³/day)`
							: `demand object "${o.name}": a demand from population × litres a day is sized per unit (a count and litres per unit per day)`
					);
			}
		}
		// Where its water comes from (engine ≥ 1.65.0, docs/model.md §2.7j): the dam or a river abstraction, whose pump and pool are sizes.
		waterSourceIssues(o.waterSource, o.riverPumpM3Day, o.riverPoolM3, (k, why) => add(`${k}:${o.id}`, `demand object "${o.name}": ${why}`));
		// Its schedule (engine ≥ 1.17.0): each window runs as entered, and not too many of them.
		if (Array.isArray(o.schedule)) {
			if (o.schedule.length > DEMAND_SCHEDULE_MAX_WINDOWS) add(`doScheduleCount:${o.id}`, `demand object "${o.name}": its schedule has ${o.schedule.length} windows, at most ${DEMAND_SCHEDULE_MAX_WINDOWS}`);
			o.schedule.forEach((w, i) => {
				const bad = scheduleWindowProblem(w);
				if (bad) add(`doSchedule:${o.id}:${i}`, `demand object "${o.name}": schedule window ${i + 1}${w.label ? ` ("${w.label}")` : ''}: ${bad}`);
			});
		}
	}
	// The crop supply tables (engine ≥ 1.73.0, docs/model.md §2.7k): shares that add up, and a remote dam the run can draw on.
	cropSupplyIssues(
		m.nodes,
		m.transfers.filter((tr) => tr.enabled && tr.source === 'river'),
		add
	);
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
		// An other water user has a pump capacity but no supply rule (engine ≥ 1.58.0); a gauge has neither.
		const supply = n.supplyRule ?? 'damFirst';
		const hasPump = n.pumpCapacityM3Day !== null && n.pumpCapacityM3Day !== undefined;
		if (n.kind === 'user' && supply !== 'damFirst') add(`supplyKind:${n.id}`, `"${n.name}": only a unit has a supply rule; an other water user always takes from the river, up to its pump capacity`);
		else if (n.kind === 'gauge' && (supply !== 'damFirst' || hasPump)) add(`supplyKind:${n.id}`, `"${n.name}": only a unit has a supply rule and river pump`);
		else if (supply === 'trigger' && !(n.damCapacityM3 > 0)) add(`supplyTrigger:${n.id}`, `"${n.name}": the trigger supply rule needs a farm dam to switch on`);
		else if (supply === 'runOfRiver' && n.damCapacityM3 > 0) add(`supplyRor:${n.id}`, `"${n.name}": run of river has no dam; set the dam capacity to 0 or pick another supply rule`);
		// The crops' water source (engine ≥ 1.65.0, docs/model.md §2.7j): a unit's; the dam or a river abstraction.
		const cropRiver = (n.cropWaterSource !== null && n.cropWaterSource !== undefined && n.cropWaterSource !== 'dam') || (n.cropRiverPumpM3Day ?? null) !== null || (n.cropRiverPoolM3 ?? null) !== null;
		if (n.kind !== 'farm' && cropRiver) add(`cropSourceKind:${n.id}`, `"${n.name}": only a unit's crops have a water source`);
		else waterSourceIssues(n.cropWaterSource, n.cropRiverPumpM3Day, n.cropRiverPoolM3, (k, why) => add(`crop${k[0]!.toUpperCase()}${k.slice(1)}:${n.id}`, `"${n.name}": the crops' ${why}`));
		if (n.kind === 'farm' && supply === 'trigger' && (n.supplyStopPct ?? SUPPLY_DEFAULTS.supplyStopPct) < (n.supplyTriggerPct ?? SUPPLY_DEFAULTS.supplyTriggerPct))
			add(`supplyStop:${n.id}`, `"${n.name}": the supply rule's stop level must be at least its trigger level`);
		// Hands-off flow and River to dam by month (engine ≥ 1.32.0): a farm's, 12 monthly values each.
		const hasOps = (n.handsOffM3Day !== null && n.handsOffM3Day !== undefined) || n.handsOffEwr === true || (n.divertMonthlyM3Day !== null && n.divertMonthlyM3Day !== undefined);
		if (n.kind !== 'farm' && hasOps) add(`operatingKind:${n.id}`, `"${n.name}": only a unit has a hands-off flow and River to dam by month`);
		else {
			if (n.handsOffM3Day && n.handsOffM3Day.length !== 12) add(`handsOffMonths:${n.id}`, `"${n.name}": the hands-off flow needs 12 values (m³/day, Oct–Sep)`);
			if (n.divertMonthlyM3Day && n.divertMonthlyM3Day.length !== 12) add(`divertMonths:${n.id}`, `"${n.name}": River to dam by month needs 12 values (m³/day, Oct–Sep)`);
		}
		// Dam survey curve (WP-3.5): only a unit has a dam, and the curve must be one the run can use.
		if (n.damCurve && n.damCurve.length) {
			const bad = n.kind === 'farm' ? damCurveProblem(n.damCurve) : `only a unit has a dam`;
			if (bad) add(`damCurve:${n.id}`, `"${n.name}": dam survey curve: ${bad}`);
		}
		// Development over the run (engine ≥ 1.30.0): the sediment rate, its survey date and the dates read.
		const dev = developmentProblem(n);
		if (dev) add(`development:${n.id}`, `"${n.name}": ${dev}`);
	}
	for (const a of m.cropAreas) {
		const n = byId.get(a.nodeId);
		if (!n) add(`caNode:${a.nodeId}/${a.cropId}`, `crop area references unknown node ${a.nodeId}`);
		else if (n.kind === 'user') add(`caUser:${a.nodeId}`, `crop area on other water user "${n.name}": a user's demand is its monthly demand, not crops`);
		if (!cropIds.has(a.cropId)) add(`caCrop:${a.nodeId}/${a.cropId}`, `crop area references unknown crop ${a.cropId}`);
	}
	// The irrigation systems (engine ≥ 1.72.0): a crop or planting names a row of the table (its id, or the key of the
	// SABI preset a row started as). Without a table the project's own applies, which only the store can check.
	if (m.irrigationSystems) {
		dupes('irrigation system id', m.irrigationSystems.map((x) => x.id));
		dupes('irrigation system name', m.irrigationSystems.map((x) => x.name.trim().toLowerCase()), (x) => `"${x}"`);
		const known = new Set(m.irrigationSystems.flatMap((x) => (x.preset ? [x.id, x.preset] : [x.id])));
		for (const c of m.crops)
			if (c.irrigationSystemId != null && !known.has(c.irrigationSystemId)) add(`cropSystem:${c.id}`, `crop "${c.name}" names irrigation system ${c.irrigationSystemId}, which is not in the table`);
		for (const a of m.cropAreas)
			if (a.irrigationSystemId != null && !known.has(a.irrigationSystemId))
				add(`caSystem:${a.nodeId}/${a.cropId}`, `"${byId.get(a.nodeId)?.name ?? a.nodeId}": a crop names irrigation system ${a.irrigationSystemId}, which is not in the table`);
	}
	const nodeIndex = new Map(m.nodes.map((n, i) => [n.id, i]));
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
			// Canal seepage back to the river (engine ≥ 1.42.0): a share 0–100 %, rejoining below the source or a farm below it.
			const back = t.lossReturnPct ?? 0;
			if (!(back >= 0 && back <= 1)) add(`trRiverReturn:${t.id}`, `river off-take ${t.id}: the share of the losses seeping back must be between 0 % and 100 %`);
			const at = t.lossReturnNodeId;
			if (a && at !== null && at !== undefined) {
				if (offtakeReturnAt(t, nodeIndex.get(a.id)!, m.nodes, nodeIndex) === undefined)
					add(`trRiverReturnAt:${t.id}`, `river off-take ${t.id}: its seepage can rejoin the river only below "${a.name}" or a unit downstream of it`);
			}
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

/**
 * A demand's water source fields (engine ≥ 1.65.0): the source one of
 * WATER_SOURCES (or none: the dam), the river pump a size ≥ 0 or none (no
 * limit), the pool a size ≥ 0 or none. A pump or pool kept on a demand that
 * draws on the dam is inert, so it is allowed.
 */
function waterSourceIssues(source: unknown, pump: unknown, pool: unknown, add: (key: string, why: string) => void): void {
	const size = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
	if (source !== null && source !== undefined && !(WATER_SOURCES as readonly unknown[]).includes(source)) add('waterSource', `water source must be one of ${WATER_SOURCES.join(', ')}`);
	if (!size(pump)) add('riverPump', 'river pump capacity must be a size ≥ 0 m³/day, or none for no limit');
	if (!size(pool)) add('riverPool', 'pool at the river pump must be a size ≥ 0 m³, or none');
}
