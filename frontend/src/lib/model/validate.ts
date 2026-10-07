// Client-side mirror of the PUT /projects/:id/model validation in docs/api.md,
// so the editor can flag problems before a save round-trip.
import { cropSupplyIssues, DAM_AREA_EXPONENT_MAX, damCurveProblem, DEMAND_OBJECT_MAX_RANK, DEMAND_OBJECT_SOURCE_SIZING, DEMAND_SCHEDULE_MAX_WINDOWS, developmentProblem, GA538_GROUNDWATER_RATES, hasNameControlChars, isGa538Rate, isRiverOfftake, monthlyRatesMismatch, offtakeReturnAt, REACH_LOSS_FRAC_MAX, scheduleWindowProblem, SUPPLY_DEFAULTS, type DemandObject, type NetworkNode, type ProjectModel } from '@water-management/engine';

export interface ModelIssue {
	/** Which editor tab the issue belongs to. */
	area: 'network' | 'crops' | 'transfers';
	message: string;
	/**
	 * The item it is about, in its area's list: a node (network), a crop (crops) or a transfer
	 * (transfers). The save bar and the save rows link to it (issueHref); absent for an issue
	 * about the list as a whole or about something that no longer exists.
	 */
	itemId?: string;
}

/**
 * Where an issue is fixed, as a link within the project's workspace: the node's sheet
 * (`edit=`), the crop's sheet (`crop=`), the transfer's card (its heading, which the Transfers
 * page focuses on landing), or the area's page when the issue names no item.
 */
export function issueHref(issue: Pick<ModelIssue, 'area' | 'itemId'>): string {
	const id = issue.itemId ? encodeURIComponent(issue.itemId) : null;
	if (!id) return `?tab=${issue.area}`;
	if (issue.area === 'network') return `?tab=network&edit=${id}`;
	if (issue.area === 'crops') return `?tab=crops&crop=${id}`;
	return `?tab=transfers#${transferAnchor(issue.itemId!)}`;
}

/** The anchor id of a transfer's card heading (TransfersTab), which issueHref links to. */
export const transferAnchor = (id: string) => `tr-${id}-h`;

const inRange = (v: number, lo: number, hi: number) => !Number.isNaN(v) && v >= lo && v <= hi;
/** The API refuses a name or label holding a line break or other control character (issue #385, engine NAME_CONTROL_CHARS). */
const ONE_LINE = "can't contain line breaks or control characters";

/**
 * A node's supply rule and river pump problems (WP-3.8), as the API refuses
 * them (engine modelRules), in words for the node form, which shows them
 * beside the fields; validateModel names the node in front.
 */
export function supplyIssues(
	n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'supplyRule' | 'pumpCapacityM3Day' | 'supplyTriggerPct' | 'supplyStopPct'>
): string[] {
	const out: string[] = [];
	const rule = n.supplyRule ?? SUPPLY_DEFAULTS.supplyRule;
	const pump = n.pumpCapacityM3Day ?? null;
	const trigger = n.supplyTriggerPct ?? SUPPLY_DEFAULTS.supplyTriggerPct;
	const stop = n.supplyStopPct ?? SUPPLY_DEFAULTS.supplyStopPct;
	// An other water user has a pump capacity of its own (engine ≥ 1.58.0), but no supply rule; a gauge has neither.
	if (n.kind === 'user') {
		if (rule !== 'damFirst') out.push('only a hydrological unit has a supply rule; an other water user always takes from the river, up to its pump capacity. Set the supply rule to dam only.');
		if (pump !== null && !inRange(pump, 0, Infinity)) out.push("the pump capacity can't be negative.");
		return out;
	}
	if (n.kind !== 'farm') {
		if (rule !== 'damFirst' || pump !== null) out.push('only a hydrological unit has a supply rule and river pump; set the supply rule to dam only and clear the pump capacity.');
		return out;
	}
	if (rule === 'trigger' && !(n.damCapacityM3 > 0)) out.push('the “dam, river when low” supply rule needs a dam to switch on; enter a dam capacity or pick another supply rule.');
	if (rule === 'runOfRiver' && n.damCapacityM3 > 0) out.push('run of river has no dam; set the dam capacity to 0 or pick another supply rule.');
	if (pump !== null && !inRange(pump, 0, Infinity)) out.push("the river pump capacity can't be negative.");
	if (!inRange(trigger, 0, 1) || !inRange(stop, 0, 1)) out.push('the supply switch levels must be between 0% and 100%.');
	else if (rule === 'trigger' && stop < trigger) out.push('the switch-back level must be at least the switch-to-river level.');
	return out;
}

/**
 * A node's hands-off flow and River to dam by month problems (engine ≥
 * 1.32.0, issue #204), as the API refuses them (engine modelRules and the
 * backend's zod: 12 finite values ≥ 0), in words for the node form; farms
 * only.
 */
export function operatingIssues(n: Pick<NetworkNode, 'kind' | 'handsOffM3Day' | 'handsOffEwr' | 'divertMonthlyM3Day'>): string[] {
	const handsOff = n.handsOffM3Day ?? null;
	const divert = n.divertMonthlyM3Day ?? null;
	if (n.kind !== 'farm') {
		return handsOff !== null || n.handsOffEwr === true || divert !== null
			? ['only a hydrological unit has a hands-off flow and River to dam by month; clear them.']
			: [];
	}
	const bad = (row: number[]) => row.length !== 12 || row.some((v) => !Number.isFinite(v) || v < 0);
	const out: string[] = [];
	if (handsOff !== null && bad(handsOff)) out.push('the hands-off flow needs 12 monthly values, none negative.');
	if (divert !== null && bad(divert)) out.push('River to dam by month needs 12 monthly values, none negative.');
	return out;
}

/**
 * The crop supply tables' problems (engine ≥ 1.73.0, issue #408, docs/model.md
 * §2.7k), as the API refuses them (the engine's cropSupplyIssues, through
 * modelRules): each with the node it is about and the words after its name.
 * Shares that don't add up to 100 %, a remote share without another unit with
 * a dam, a dam the unit drains into, a negative pipe.
 */
export function cropSupplyProblems(model: Pick<ProjectModel, 'nodes' | 'transfers'>): { nodeId: string; message: string }[] {
	const out: { nodeId: string; message: string }[] = [];
	const offtakes = model.transfers.filter((t) => t.enabled && isRiverOfftake(t));
	cropSupplyIssues(model.nodes, offtakes, (key, message) => {
		const nodeId = key.slice(key.indexOf(':') + 1);
		const n = model.nodes.find((x) => x.id === nodeId);
		// The engine names the unit first ("Name": …); the form shows its own name above, so the words after it.
		const prefix = n ? `"${n.name}": ` : '';
		out.push({ nodeId, message: prefix && message.startsWith(prefix) ? message.slice(prefix.length) : message });
	});
	return out;
}

/**
 * Why a node's EWR site flag (engine ≥ 1.5.0) can't be saved, as the API
 * refuses it (engine modelRules), or null: the outlet is always an EWR site,
 * and only a gauge can be taken off.
 */
export function ewrSiteIssue(n: Pick<NetworkNode, 'kind' | 'downstreamNodeId' | 'ewrSite'>): string | null {
	if (n.ewrSite !== false) return null;
	if (n.downstreamNodeId === null) return 'the outlet is always an EWR site; tick “EWR site”.';
	if (n.kind !== 'gauge') return 'only a gauge can be taken off the EWR sites; tick “EWR site”.';
	return null;
}

/**
 * Why a node's development fields (engine ≥ 1.30.0, issue #67: the dam's
 * survey date, sediment rate and in-service date, the abstraction start)
 * can't be saved, as the API refuses them (engine developmentProblem, through
 * modelRules), in the editor's words, or null.
 */
export function developmentIssue(n: Pick<NetworkNode, 'kind' | 'damSurveyDate' | 'damSedimentPctPerYear' | 'damInServiceFrom' | 'abstractionFrom'>): string | null {
	const p = developmentProblem(n);
	return p === null ? null : `${p.replace('only a unit has a dam', 'only a hydrological unit has a dam; clear its dam dates and sediment rate')}.`;
}

/**
 * Every problem the API would refuse the model for. (A return flow above a
 * unit's losses isn't one: its crops' systems can move the losses from another
 * screen, so the unit form warns and a run caps it, engine ≥ 1.72.0;
 * returnFlowHint in network/fields.ts.)
 */
export function validateModel(model: ProjectModel): ModelIssue[] {
	const issues: ModelIssue[] = [];
	const { nodes, crops, cropAreas, transfers } = model;
	const nodeIds = new Set(nodes.map((n) => n.id));
	const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name || '(unnamed)';

	// Names
	const seen = new Map<string, number>();
	for (const n of nodes) {
		const key = n.name.trim().toLowerCase();
		if (!key) {
			issues.push({ area: 'network', itemId: n.id, message: 'Every hydrological unit needs a name.' });
			continue;
		}
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	for (const [key, count] of seen) {
		if (count > 1) {
			const first = nodes.find((n) => n.name.trim().toLowerCase() === key)!;
			const display = first.name.trim();
			issues.push({ area: 'network', itemId: first.id, message: `Hydrological unit name "${display}" is used ${count} times.` });
		}
	}

	// References
	for (const n of nodes) {
		if (n.downstreamNodeId === n.id) {
			issues.push({ area: 'network', itemId: n.id, message: `"${nodeName(n.id)}" drains into itself.` });
		} else if (n.downstreamNodeId !== null && !nodeIds.has(n.downstreamNodeId)) {
			issues.push({ area: 'network', itemId: n.id, message: `"${nodeName(n.id)}" drains into a hydrological unit that no longer exists.` });
		}
	}

	// Ranges (the API rejects these with a 400)
	const FRACTIONS = ['pctUpstreamToDam', 'pctRunoffToDam', 'damInitialPct', 'damMinPct', 'irrigationEfficiency', 'returnFlowFraction', 'damSeepagePerDay'] as const;
	const NON_NEG = ['areaKm2', 'areaHiKm2', 'areaLoKm2', 'damCapacityM3', 'divertCapacityM3Day'] as const;
	for (const n of nodes) {
		const label = `"${nodeName(n.id)}"`;
		if (n.name.trim().length > 100) issues.push({ area: 'network', itemId: n.id, message: `${label}: names are limited to 100 characters.` });
		if (hasNameControlChars(n.name)) issues.push({ area: 'network', itemId: n.id, message: `${label}: names ${ONE_LINE}.` });
		const badFrac = FRACTIONS.some((k) => !inRange(n[k], 0, 1)) || (n.flowShareManual !== null && !inRange(n.flowShareManual, 0, 1));
		if (badFrac) issues.push({ area: 'network', itemId: n.id, message: `${label}: percentages must be between 0% and 100%.` });
		else if (!(n.irrigationEfficiency > 0)) issues.push({ area: 'network', itemId: n.id, message: `${label}: irrigation efficiency must be above 0%.` });

		// At most 1 (engine ≥ 1.63.0): no basin's surface grows faster than its volume (model.md §2.7a).
		if (!(n.damAreaExponent > 0 && n.damAreaExponent <= DAM_AREA_EXPONENT_MAX)) issues.push({ area: 'network', itemId: n.id, message: `${label}: the dam area exponent must be above 0 and at most ${DAM_AREA_EXPONENT_MAX}.` });
		if (n.damAreaFullM2 !== null && !inRange(n.damAreaFullM2, 0, Infinity)) issues.push({ area: 'network', itemId: n.id, message: `${label}: the dam area can't be negative.` });
		if (NON_NEG.some((k) => !inRange(n[k], 0, Infinity))) {
			issues.push({ area: 'network', itemId: n.id, message: `${label}: areas and capacities can't be negative.` });
		}
		// Boreholes (WP-1.34), as the API checks them.
		if ((n.boreholeCapacityM3Day ?? 0) > 0) {
			if (n.kind === 'gauge') issues.push({ area: 'network', itemId: n.id, message: `${label}: a gauge can't have boreholes.` });
			else if (n.boreholeRule === 'drought' && !(n.kind === 'farm' && n.damCapacityM3 > 0))
				issues.push({ area: 'network', itemId: n.id, message: `${label}: the drought borehole rule needs a dam on the hydrological unit to trigger on.` });
		}
		if (!inRange(n.boreholeCapacityM3Day ?? 0, 0, Infinity) || !inRange(n.streamDepletionLagDays ?? 0, 0, 36_500))
			issues.push({ area: 'network', itemId: n.id, message: `${label}: borehole capacity and depletion lag can't be negative.` });
		if (!inRange(n.streamDepletionFrac ?? 0, 0, 1) || !inRange(n.boreholeTriggerPct ?? 0.3, 0, 1))
			issues.push({ area: 'network', itemId: n.id, message: `${label}: stream depletion and the drought trigger must be between 0% and 100%.` });
		// GN 538 context (engine ≥ 1.12.0), as the API checks them.
		if (n.gaPropertyAreaHa != null && !inRange(n.gaPropertyAreaHa, 0, 10_000_000))
			issues.push({ area: 'network', itemId: n.id, message: `${label}: the GN 538 property area must be between 0 and 10 000 000 ha.` });
		if (n.gaRateM3HaYear != null && !isGa538Rate(n.gaRateM3HaYear))
			issues.push({ area: 'network', itemId: n.id, message: `${label}: the GN 538 rate must be one of ${GA538_GROUNDWATER_RATES.join(', ')} m³/ha/a.` });
		// Dam storage (WP-3.5), as the API checks them.
		if (!inRange(n.damSeepageReturnPct ?? 1, 0, 1)) issues.push({ area: 'network', itemId: n.id, message: `${label}: the share of seepage returning must be between 0% and 100%.` });
		if (!inRange(n.damOutletCapacityM3Day ?? 0, 0, Infinity)) issues.push({ area: 'network', itemId: n.id, message: `${label}: the dam outlet capacity can't be negative.` });
		if (n.damReleaseM3Day && (n.damReleaseM3Day.length !== 12 || n.damReleaseM3Day.some((v) => !inRange(v, 0, Infinity))))
			issues.push({ area: 'network', itemId: n.id, message: `${label}: the dam release needs 12 monthly values, none negative.` });
		if (n.damCurve && n.damCurve.length) {
			const bad = n.kind === 'farm' ? damCurveProblem(n.damCurve) : 'only a hydrological unit has a dam';
			if (bad) issues.push({ area: 'network', itemId: n.id, message: `${label}: dam survey curve: ${bad}.` });
		}
		// Bed losses in the reach below (engine ≥ 1.75.0), as the API checks them: a share up to 50 %, a cap ≥ 0, none on the outlet.
		if (!inRange(n.reachLossFrac ?? 0, 0, REACH_LOSS_FRAC_MAX))
			issues.push({ area: 'network', itemId: n.id, message: `${label}: the share of the flow lost in the reach below must be between 0% and ${REACH_LOSS_FRAC_MAX * 100}%.` });
		if (!inRange(n.reachLossMaxM3Day ?? 0, 0, Infinity)) issues.push({ area: 'network', itemId: n.id, message: `${label}: the most lost in the reach below in a day can't be negative.` });
		if (n.downstreamNodeId === null && (n.reachLossFrac ?? 0) > 0)
			issues.push({ area: 'network', itemId: n.id, message: `${label}: the outlet has no reach below it in the model; set its bed losses to 0%.` });
		// Development over the run (engine ≥ 1.30.0), as the API checks it.
		const development = developmentIssue(n);
		if (development) issues.push({ area: 'network', itemId: n.id, message: `${label}: ${development}` });
		// Supply rule and river pump (WP-3.8), as the API checks them.
		for (const m of supplyIssues(n)) issues.push({ area: 'network', itemId: n.id, message: `${label}: ${m}` });
		// Hands-off flow and River to dam by month (engine ≥ 1.32.0), as the API checks them.
		for (const m of operatingIssues(n)) issues.push({ area: 'network', itemId: n.id, message: `${label}: ${m}` });
		// EWR site flag (engine ≥ 1.5.0), as the API checks it.
		const ewrSite = ewrSiteIssue(n);
		if (ewrSite) issues.push({ area: 'network', itemId: n.id, message: `${label}: ${ewrSite}` });
		// Other water users (WP-1.33), as the API checks them.
		if (n.kind === 'user') {
			if (!inRange(n.userReturnPct ?? 0, 0, 1)) issues.push({ area: 'network', itemId: n.id, message: `${label}: the share returned must be between 0% and 100%.` });
			if (n.userDemandM3Day && (n.userDemandM3Day.length !== 12 || n.userDemandM3Day.some((v) => !inRange(v, 0, Infinity))))
				issues.push({ area: 'network', itemId: n.id, message: `${label}: demand needs 12 monthly values, none negative.` });
			if (cropAreas.some((a) => a.nodeId === n.id)) issues.push({ area: 'crops', message: `${label} is an other water user: its demand is monthly, so remove its crop areas.` });
		}
	}

	// The crop supply tables (engine ≥ 1.73.0), as the API checks them.
	for (const p of cropSupplyProblems(model)) {
		const n = nodes.find((x) => x.id === p.nodeId);
		issues.push({ area: 'network', itemId: p.nodeId, message: `"${n?.name || '?'}": ${p.message}` });
	}

	// Exactly one outlet (unless empty)
	if (nodes.length > 0) {
		const outlets = nodes.filter((n) => n.downstreamNodeId === null);
		if (outlets.length === 0) {
			issues.push({ area: 'network', message: 'The network needs one outlet (a hydrological unit that drains nowhere).' });
		} else if (outlets.length > 1) {
			issues.push({
				area: 'network',
				message: `The network has ${outlets.length} outlets (${outlets.map((n) => `"${n.name}"`).join(', ')}); exactly one hydrological unit may drain nowhere.`
			});
		}
	}

	// Cycles: walk downstream from each node; revisiting a node on the same walk is a cycle.
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const reported = new Set<string>();
	for (const start of nodes) {
		const path: string[] = [];
		const onPath = new Set<string>();
		let cur: string | null = start.id;
		while (cur !== null && byId.has(cur) && !onPath.has(cur)) {
			onPath.add(cur);
			path.push(cur);
			cur = byId.get(cur)!.downstreamNodeId;
		}
		if (cur !== null && onPath.has(cur)) {
			const loop = path.slice(path.indexOf(cur));
			const sig = [...loop].sort().join('|');
			// Length-1 loops (self-drainage) are reported above.
			if (loop.length > 1 && !reported.has(sig)) {
				reported.add(sig);
				issues.push({
					area: 'network',
					itemId: cur,
					message: `Cycle in the network: ${loop.map(nodeName).join(' → ')} → ${nodeName(cur)}.`
				});
			}
		}
	}

	// Crops
	const cropIds = new Set(crops.map((c) => c.id));
	const cropNames = new Map<string, number>();
	for (const c of crops) {
		const key = c.name.trim().toLowerCase();
		if (!key) issues.push({ area: 'crops', itemId: c.id, message: 'Every crop needs a name.' });
		else cropNames.set(key, (cropNames.get(key) ?? 0) + 1);
		if (hasNameControlChars(c.name)) issues.push({ area: 'crops', itemId: c.id, message: `Crop "${c.name}": names ${ONE_LINE}.` });
		if (c.cropFactor.length !== 12 || c.cropFactor.some((f) => !inRange(f, 0, Infinity))) {
			issues.push({ area: 'crops', itemId: c.id, message: `Crop "${c.name}" needs 12 non-negative monthly factors.` });
		}
	}
	for (const [key, count] of cropNames) {
		if (count > 1) issues.push({ area: 'crops', itemId: crops.find((c) => c.name.trim().toLowerCase() === key)?.id, message: `Crop name "${key}" is used ${count} times.` });
	}
	if (cropAreas.some((a) => !nodeIds.has(a.nodeId) || !cropIds.has(a.cropId))) {
		issues.push({ area: 'crops', message: 'A crop area refers to a deleted hydrological unit or crop.' });
	}
	if (cropAreas.some((a) => !inRange(a.areaM2, 0, Infinity))) {
		issues.push({ area: 'crops', message: "Crop areas can't be negative." });
	}

	// Land cover (WP-1.35), as the API checks it.
	for (const lc of model.landCover ?? []) {
		const n = nodes.find((x) => x.id === lc.nodeId);
		if (!n) issues.push({ area: 'network', message: 'A land-cover patch refers to a deleted hydrological unit.' });
		else if (n.kind !== 'farm') issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `"${nodeName(n.id)}": land cover lies on a hydrological unit, not a ${n.kind === 'user' ? 'user' : 'gauge'}.` });
		if (!inRange(lc.areaKm2, 0, Infinity) || !inRange(lc.densityPct, 0, 1) || (lc.factors && (!inRange(lc.factors.mar, 0, 1) || !inRange(lc.factors.lowFlow, 0, 1))))
			issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `Land cover on "${n ? nodeName(n.id) : '?'}": area can't be negative, cover and reductions are 0–100%.` });
	}

	// Individual boreholes (WP-3.9), as the API checks them (engine modelRules).
	for (const b of model.boreholes ?? []) {
		const n = nodes.find((x) => x.id === b.nodeId);
		const label = `Borehole "${b.name || '?'}"${n ? ` on "${nodeName(n.id)}"` : ''}`;
		if (!n) issues.push({ area: 'network', message: 'A borehole refers to a deleted hydrological unit.' });
		else if (n.kind === 'gauge') issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: a gauge can't have boreholes.` });
		else if (b.mode !== 'none' && !(n.kind === 'farm' && n.damCapacityM3 > 0)) {
			if (b.mode === 'emergency') issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: emergency mode needs a dam on the hydrological unit to trigger on.` });
			if (b.target === 'dam') issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: it pumps into a dam, and there is none.` });
		}
		if (!b.name.trim()) issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: 'Every borehole needs a name.' });
		if (hasNameControlChars(b.name)) issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: names ${ONE_LINE}.` });
		if (!inRange(b.capacityM3Day, 0, Infinity) || (b.annualCapM3 !== null && !inRange(b.annualCapM3, 0, Infinity)) || !inRange(b.emergencyBelowPct, 0, 1) || !inRange(b.depletionFactor, 0, 1))
			issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: capacity and annual cap can't be negative; the emergency level and depletion are 0–100%.` });
	}

	// Demand objects (engine ≥ 1.7.0, issue #54 item 2b), as the API checks them (engine modelRules).
	for (const o of model.demandObjects ?? []) {
		const n = nodes.find((x) => x.id === o.nodeId);
		const label = `Demand object "${o.name || '?'}"${n ? ` on "${nodeName(n.id)}"` : ''}`;
		if (!n) issues.push({ area: 'network', message: 'A demand object refers to a deleted hydrological unit.' });
		else if (n.kind !== 'farm') issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: only a hydrological unit has demand objects.` });
		if (!o.name.trim()) issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: 'Every demand object needs a name.' });
		if (hasNameControlChars(o.name)) issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: names ${ONE_LINE}.` });
		if (o.sizing === 'monthly' && (!o.monthlyM3Day || o.monthlyM3Day.length !== 12 || o.monthlyM3Day.some((v) => !inRange(v, 0, Infinity))))
			issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: a monthly demand needs 12 values, none negative.` });
		if (o.sizing === 'perUnit' && (o.count === null || o.litresPerUnitDay === null || !inRange(o.count, 0, Infinity) || !inRange(o.litresPerUnitDay, 0, Infinity)))
			issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: a demand per unit needs a count and litres per unit per day, neither negative.` });
		if (!inRange(o.lossPct, 0, 0.999999) || !inRange(o.returnPct, 0, 1) || (o.monthlyFactor ?? []).some((v) => !inRange(v, 0, Infinity)))
			issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: losses are 0–99%, the return share 0–100%, and the monthly profile can't be negative.` });
		if (o.destination === 'external' && o.returnPct > 0) issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: water piped out of the catchment returns nothing; set its return share to 0%.` });
		// The people it serves, for the basic-needs floor (engine ≥ 1.44.0): the API refuses a negative one.
		if (o.population !== null && o.population !== undefined && !inRange(o.population, 0, Infinity))
			issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: the people it serves can't be negative.` });
		// Its rank within its priority class (engine ≥ 1.64.0): a whole number 1–99, or none; the supply order writes only these.
		if (o.rank !== null && o.rank !== undefined && !(Number.isInteger(o.rank) && o.rank >= 1 && o.rank <= DEMAND_OBJECT_MAX_RANK))
			issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: its rank in the supply order must be a whole number from 1 to ${DEMAND_OBJECT_MAX_RANK}.` });
		// Where its number comes from (engine ≥ 1.56.0): the sizing that source gives a volume (the form keeps them in step).
		if (o.source !== null && o.source !== undefined) {
			const sizing = (DEMAND_OBJECT_SOURCE_SIZING as Record<string, DemandObject['sizing'] | null | undefined>)[o.source];
			if (sizing === undefined) issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: choose where its number comes from.` });
			else if (sizing !== null && o.sizing !== sizing)
				issues.push({
					area: 'network',
					message: sizing === 'monthly' ? `${label}: ${o.source === 'meter' ? 'meter records give' : 'an AADD gives'} a volume, so give the demand as m³/day by month.` : `${label}: a demand from population × litres a day is given as a count × litres a day.`
				});
		}
		// Its schedule (engine ≥ 1.17.0): the engine's own window rule, as the API applies it.
		if ((o.schedule?.length ?? 0) > DEMAND_SCHEDULE_MAX_WINDOWS) issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: a schedule has at most ${DEMAND_SCHEDULE_MAX_WINDOWS} windows.` });
		(o.schedule ?? []).forEach((w, i) => {
			const bad = scheduleWindowProblem(w) ?? (hasNameControlChars(w.label ?? '') ? `labels ${ONE_LINE}` : null);
			if (bad) issues.push({ area: 'network', ...(n ? { itemId: n.id } : {}), message: `${label}: schedule window ${i + 1}${w.label ? ` ("${w.label}")` : ''}: ${bad}.` });
		});
	}

	// Transfers
	transfers.forEach((t, i) => {
		const label = `Transfer ${i + 1}`;
		if (!nodeIds.has(t.fromNodeId) || !nodeIds.has(t.toNodeId)) {
			issues.push({ area: 'transfers', itemId: t.id, message: `${label}: choose both a source and a destination hydrological unit.` });
		} else if (t.fromNodeId === t.toNodeId) {
			issues.push({ area: 'transfers', itemId: t.id, message: `${label}: source and destination are the same hydrological unit.` });
		} else {
			// Both ends a hydrological unit (the API refuses an other water user; the engine skips a gauge's rule
			// with only a run warning, so it is refused here before it saves as a rule that does nothing).
			for (const id of [t.fromNodeId, t.toNodeId]) {
				const end = nodes.find((n) => n.id === id)!;
				if (end.kind === 'user') issues.push({ area: 'transfers', itemId: t.id, message: `${label}: "${nodeName(id)}" is an other water user; transfers run between hydrological units’ dams.` });
				else if (end.kind === 'gauge') issues.push({ area: 'transfers', itemId: t.id, message: `${label}: "${nodeName(id)}" is a gauge, which can't send or receive water; choose a hydrological unit.` });
			}
		}
		if (t.months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
			issues.push({ area: 'transfers', itemId: t.id, message: `${label}: months must be 1–12.` });
		}
		if (!Number.isInteger(t.priority)) {
			issues.push({ area: 'transfers', itemId: t.id, message: `${label}: priority must be a whole number.` });
		}
		if (!inRange(t.minStoragePct, 0, 1)) {
			issues.push({ area: 'transfers', itemId: t.id, message: `${label}: minimum storage must be between 0% and 100%.` });
		}
		if (!inRange(t.maxRateM3s, 0, Infinity) || (t.dailyCapM3 !== null && !inRange(t.dailyCapM3, 0, Infinity))) {
			issues.push({ area: 'transfers', itemId: t.id, message: `${label}: rates and caps can't be negative.` });
		}
		// Monthly rates (engine ≥ 1.14.0): twelve, none negative, with the months and max rate kept in step.
		const monthly = monthlyRatesMismatch(t);
		if (monthly) issues.push({ area: 'transfers', itemId: t.id, message: `${label}: ${monthly}.` });
		// A river off-take (engine ≥ 1.14.0): unit to unit (checked above, as for every rule), its losses below 100 %, its hands-off flow not negative.
		if (isRiverOfftake(t)) {
			if (!inRange(t.lossPct ?? 0, 0, 0.999999)) issues.push({ area: 'transfers', itemId: t.id, message: `${label}: conveyance losses are 0–99%.` });
			if (t.handsOffM3Day != null && !inRange(t.handsOffM3Day, 0, Infinity)) issues.push({ area: 'transfers', itemId: t.id, message: `${label}: the hands-off flow can't be negative.` });
			// Canal seepage back to the river (engine ≥ 1.42.0): a share 0–100 %, rejoining below the source or a farm below it.
			if (!inRange(t.lossReturnPct ?? 0, 0, 1)) issues.push({ area: 'transfers', itemId: t.id, message: `${label}: the share of the losses seeping back is 0–100%.` });
			if (t.lossReturnNodeId && nodes.some((n) => n.id === t.fromNodeId) && offtakeReturnAt(t, nodes.findIndex((n) => n.id === t.fromNodeId), nodes) === undefined)
				issues.push({ area: 'transfers', itemId: t.id, message: `${label}: the seepage can rejoin the river only below the source or a hydrological unit downstream of it.` });
		}
	});

	return issues;
}
