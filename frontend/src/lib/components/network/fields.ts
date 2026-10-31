// The numeric node fields, in the order the editor shows them, with units and
// plain-language help. Percent fields are stored 0–1 and shown as %.
import { pumpUnit, riverToDamUnit, type FlowUnit } from './flowUnit.svelte';
import { estimatedDamAreaM2, onRiverDam, RETURN_FLOW_SLACK, type NetworkNode, type NodeKind } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';

export type NodeNumberKey =
	| 'areaKm2'
	| 'damCapacityM3'
	| 'damInitialPct'
	| 'damMinPct'
	| 'damAreaFullM2'
	| 'damAreaExponent'
	| 'damSeepagePerDay'
	| 'damSeepageReturnPct'
	| 'damOutletCapacityM3Day'
	| 'pctUpstreamToDam'
	| 'pctRunoffToDam'
	| 'divertCapacityM3Day'
	| 'irrigationEfficiency'
	| 'returnFlowFraction'
	| 'boreholeCapacityM3Day'
	| 'boreholeTriggerPct'
	| 'streamDepletionFrac'
	| 'streamDepletionLagDays'
	| 'gaPropertyAreaHa'
	| 'reachLossFrac'
	| 'reachLossMaxM3Day'
	| 'baseflowLossM3Day'
	| 'baseflowGainM3Day';

export interface NodeField {
	key: NodeNumberKey;
	/** Short column / field label. */
	label: string;
	unit: 'km²' | 'm³' | 'm²' | '%' | '%/day' | '% of supply' | 'm³/day' | 'm³/s' | 'l/s' | '×' | 'days' | 'ha';
	/** Shown = stored × scale, for a field entered in another unit than it is stored in (m³/s stored as m³/day). Percentages scale by 100 on their own. */
	scale?: number;
	group: 'area' | 'dam' | 'routing' | 'irrigation' | 'groundwater' | 'baseflow' | 'reach';
	/** Accessible name in the table, where each row repeats the field: "Area of Hilltop farm, km²". */
	aria: (name: string) => string;
	help: string;
	/** Farm-only: gauges only pass upstream flow through. */
	farmOnly?: boolean;
	/** Farms and other water users, not gauges (boreholes, WP-1.34). */
	notGauge?: boolean;
	nullable?: boolean;
	/** Only in the one-node form: rarely edited, and the table must fit a 1440px screen. */
	detailOnly?: boolean;
	/** In the one-node form, folded under its section's "More … settings" line (rarely changed; issue #521). */
	more?: boolean;
	/** A flow rate whose unit is picked beside it (./flowUnit.svelte.ts): `unit` and `scale` follow it. */
	flowUnit?: FlowUnit;
	/**
	 * Worked out from elsewhere: the efficiency, from the unit's crops' irrigation systems (engine ≥ 1.72.0). Shown as text
	 * while every planting is on a system; editable, as the efficiency for crops with no system, while one isn't
	 * (model/systems.ts ownEfficiencyUsed). Never pasted.
	 */
	derived?: boolean;
}

/** m³/day → m³/s: River to dam is entered in m³/s and stored in m³/day. */
export const M3S_PER_M3DAY = 1 / 86_400;

export const GROUPS: Record<NodeField['group'], string> = {
	area: 'Catchment area',
	dam: 'Dam',
	routing: 'Routing',
	irrigation: 'Irrigation',
	groundwater: 'Combined boreholes (one capacity)',
	baseflow: 'Base-flow loss and gain',
	reach: 'Bed losses in the reach below'
};

export const NODE_FIELDS: NodeField[] = [
	{
		key: 'areaKm2',
		label: 'Area',
		unit: 'km²',
		group: 'area',
		aria: (n) => `Area of ${n}, km²`,
		help: "The hydrological unit's own runoff area, excluding the units upstream of it. Hydrological unit areas add up to the catchment area. GR4J on the unit's own rain runs on it, so it sets the unit's natural MAR share of the flow and the EWR (its area share when there is no runoff to split by)."
	},
	{
		key: 'damCapacityM3',
		label: 'Capacity',
		unit: 'm³',
		group: 'dam',
		farmOnly: true,
		aria: (n) => `Dam capacity of ${n}, m³`,
		help: 'Full supply capacity of the hydrological unit’s dam. 0 means no dam: demand is met from the river only.'
	},
	{
		key: 'damInitialPct',
		label: 'Initial',
		unit: '%',
		group: 'dam',
		farmOnly: true,
		aria: (n) => `Dam initial storage of ${n}, %`,
		help: 'Storage on the first simulated day, as a percentage of capacity.'
	},
	{
		key: 'damMinPct',
		label: 'Minimum level',
		unit: '%',
		group: 'dam',
		farmOnly: true,
		aria: (n) => `Dam minimum operating level of ${n}, %`,
		help: 'Dead storage: irrigation draws only the water above this level, and transfers out of the dam leave at least this much. 0 % means irrigation may empty the dam.'
	},
	{
		key: 'damAreaFullM2',
		detailOnly: true,
		label: 'Area when full',
		unit: 'm²',
		group: 'dam',
		farmOnly: true,
		nullable: true,
		aria: (n) => `Dam surface area when full at ${n}, m²`,
		help: 'Water surface of the full dam, for evaporation and the rain it catches. Empty: estimated as 7.2 × capacity^0.77 m² (Maaren & Moolman 1985, a South African farm-dam relation: about 2 m deep at 100 000 m³), and the run says so. It can be far out for any one dam.'
	},
	{
		key: 'damAreaExponent',
		more: true,
		detailOnly: true,
		label: 'Area exponent',
		unit: '×',
		group: 'dam',
		farmOnly: true,
		aria: (n) => `Dam area exponent of ${n}`,
		help: 'How the surface shrinks as the dam empties: area = area when full × (storage ÷ capacity)^exponent. 0.7 suits small dams (Liebe et al. 2005; a V-shaped valley gives about 0.67); 1 is a vertical-sided pan, the most a real basin can have; allowed above 0 up to 1.'
	},
	{
		key: 'damSeepagePerDay',
		more: true,
		detailOnly: true,
		label: 'Seepage',
		unit: '%/day',
		group: 'dam',
		farmOnly: true,
		aria: (n) => `Dam seepage of ${n}, % of storage per day`,
		help: 'Share of the stored water that seeps out each day. 0 % for a sealed dam. Where it goes is the next field.'
	},
	{
		key: 'damSeepageReturnPct',
		more: true,
		detailOnly: true,
		label: 'Seepage returning',
		unit: '%',
		group: 'dam',
		farmOnly: true,
		aria: (n) => `Share of the dam seepage of ${n} returning to the river, %`,
		help: 'Share of the seepage that reaches the river below the dam the same day. The rest is lost from the catchment (to deep groundwater). 100 % by default.'
	},
	{
		key: 'damOutletCapacityM3Day',
		more: true,
		detailOnly: true,
		label: 'Outlet capacity',
		unit: 'm³/day',
		group: 'dam',
		farmOnly: true,
		nullable: true,
		aria: (n) => `Dam outlet capacity of ${n}, m³/day`,
		help: 'Most the dam’s outlet (a pipe or valve through the wall) can release in a day, for the release rule below. Empty: no limit.'
	},
	{
		key: 'pctUpstreamToDam',
		label: 'Upstream inflow to dam',
		unit: '%',
		group: 'routing',
		farmOnly: true,
		aria: (n) => `Upstream inflow entering the dam at ${n}, %`,
		help: 'Share of the water arriving from upstream hydrological units that enters the dam. 100 %: a dam on the river, which catches it all, and has no River to dam. 0 %: an off-channel dam, which the river passes by; it fills from its share of the runoff and from River to dam. (The Water Balance Tool workbook\'s formula applied it the other way round; the import converts its values, see docs/model.md §3 Q1.)'
	},
	{
		key: 'pctRunoffToDam',
		label: 'Incremental runoff to dam',
		unit: '%',
		group: 'routing',
		farmOnly: true,
		aria: (n) => `Incremental catchment runoff entering the dam at ${n}, %`,
		help: "Share of the hydrological unit's incremental catchment runoff (its own runoff, not what arrives from upstream) that enters the dam: the part of its area above the dam wall. The rest flows past below the dam."
	},
	{
		key: 'divertCapacityM3Day',
		label: 'River to dam',
		// The unit picked in the heading or the form (m³/s, l/s or m³/day; stored m³/day either way).
		flowUnit: riverToDamUnit,
		get unit() {
			return riverToDamUnit.label;
		},
		get scale() {
			return riverToDamUnit.scale;
		},
		group: 'routing',
		farmOnly: true,
		aria: (n) => `River to dam at ${n}, ${riverToDamUnit.label}`,
		help: 'Most water taken from the river into an off-channel dam, by a weir, furrow or pump, in the unit picked beside it (0.2 m³/s = 200 l/s = 17 280 m³ a day). Not available for a dam on the river (Upstream inflow to dam 100 %). It takes up to this every day of the year (or set it by month below), leaving in the river what priority water users downstream need, and the hands-off flow under Supply when there is one; without one it doesn’t leave the EWR. This is separate from the river pump under Supply, which irrigates: if one pump does both, split its capacity between the two. 0 means none.'
	},
	{
		key: 'irrigationEfficiency',
		label: 'Efficiency',
		unit: '%',
		group: 'irrigation',
		farmOnly: true,
		derived: true,
		aria: (n) => `Irrigation efficiency of ${n}, %, from its crops' irrigation systems`,
		help: "Share of the water abstracted that reaches the crop: the unit's crops' irrigation systems combined, each weighted by its yearly water requirement. The hydrological unit abstracts crop requirement ÷ efficiency. Set each crop's system in the unit's crops, or a crop's default in its sheet; the systems' efficiencies are on Crops & demand (Tables, Irrigation systems). A crop on no system uses the efficiency entered here."
	},
	{
		key: 'returnFlowFraction',
		label: 'Return flow',
		unit: '% of supply',
		group: 'irrigation',
		farmOnly: true,
		aria: (n) => `Irrigation return flow at ${n}, % of the water supplied`,
		help: 'Share of the irrigation water supplied that infiltrates the soil and returns to the river below the hydrological unit the same day. It comes out of the application losses, so it is at most 100 % − the irrigation efficiency (10 % at 90 %); the rest of the losses leaves the catchment (evaporation, deep percolation).'
	},
	{
		key: 'boreholeCapacityM3Day', // gitleaks:allow (a field name, not a secret)
		detailOnly: true,
		notGauge: true,
		label: 'Combined borehole capacity',
		// The pumps' unit, picked beside it (m³/day until changed; stored m³/day either way).
		flowUnit: pumpUnit,
		get unit() {
			return pumpUnit.label;
		},
		get scale() {
			return pumpUnit.scale;
		},
		group: 'groundwater',
		nullable: true,
		aria: (n) => `Combined borehole capacity of ${n}, ${pumpUnit.label}`,
		help: 'Most that all the boreholes together can pump in a day. Empty (or 0) means none here. Groundwater counts as supply; the rule below says when it is used.'
	},
	{
		key: 'boreholeTriggerPct',
		detailOnly: true,
		notGauge: true,
		label: 'Drought trigger',
		unit: '%',
		group: 'groundwater',
		aria: (n) => `Borehole drought trigger of ${n}, % of dam capacity`,
		help: 'Drought rule only: the boreholes run while the dam holds less than this share of its capacity at the start of the day.'
	},
	{
		key: 'streamDepletionFrac',
		more: true,
		detailOnly: true,
		notGauge: true,
		label: 'Combined stream depletion',
		unit: '%',
		group: 'groundwater',
		aria: (n) => `Share of pumping taken from the river at ${n}, %`,
		help: 'Share of the pumped volume that the river below eventually loses (base flow the pumping captures). Near 100 % for a borehole close to the river in a connected aquifer; lower where the pumping draws on storage or other outflows.'
	},
	{
		key: 'streamDepletionLagDays',
		more: true,
		detailOnly: true,
		notGauge: true,
		label: 'Combined depletion lag',
		unit: 'days',
		group: 'groundwater',
		aria: (n) => `Stream depletion lag of ${n}, days`,
		help: 'How slowly the river feels the pumping: the time constant of the delay (0 = the same day). The depletion carries on after pumping stops. A stream depletion factor (distance² × storativity ÷ transmissivity) is a first estimate.'
	},
	{
		key: 'gaPropertyAreaHa',
		more: true,
		detailOnly: true,
		notGauge: true,
		label: 'Property area (GN 538)',
		unit: 'ha',
		group: 'groundwater',
		nullable: true,
		aria: (n) => `GN 538 property area of ${n}, ha`,
		help: 'Size of the property the groundwater is taken on (land registered separately in a Deeds Office). With the Table 2 rate below it gives the general authorisation’s volume for the property, for context only.'
	},
	{
		key: 'reachLossFrac',
		detailOnly: true,
		label: 'Share of the flow lost',
		unit: '%',
		group: 'reach',
		aria: (n) => `Share of the flow below ${n} lost into the river bed before the next hydrological unit, %`,
		help: 'Share of the flow leaving here that soaks into the river bed and banks before it reaches the next hydrological unit downstream, and leaves the catchment. 0 % (the default) for a perennial reach. Set it only where a gauge shows low flows the model keeps over-simulating that abstractions and dams don’t explain; above 30 % needs a source. 100 % with a daily maximum is WRSM’s bed loss: the whole flow up to that much a day.'
	},
	{
		key: 'reachLossMaxM3Day',
		detailOnly: true,
		label: 'Most lost in a day',
		unit: 'm³/day',
		group: 'reach',
		nullable: true,
		aria: (n) => `Most lost into the river bed below ${n} in a day, m³/day`,
		help: 'The reach loses at most this much a day, however high the flow (a bed that is already wet takes no more). Empty: no limit, the share alone.'
	},
	{
		key: 'baseflowLossM3Day',
		detailOnly: true,
		farmOnly: true,
		label: 'Base-flow loss',
		unit: 'm³/day',
		group: 'baseflow',
		aria: (n) => `Base flow ${n} loses to groundwater, m³/day`,
		help: 'Water this unit’s own runoff loses to groundwater every day, before it reaches the river or the dam, at most the day’s runoff. It leaves the catchment. 0 (the default): none. Set it from evidence, such as a gauge below that the model keeps over-simulating at low flows.'
	},
	{
		key: 'baseflowGainM3Day',
		detailOnly: true,
		farmOnly: true,
		label: 'Base-flow gain',
		unit: 'm³/day',
		group: 'baseflow',
		aria: (n) => `Base flow ${n} gains from groundwater, m³/day`,
		help: 'Water that joins this unit’s runoff from groundwater every day, from outside the catchment: a spring or an aquifer that drains into the river here. 0 (the default): none. Set it from evidence, such as a flow the river keeps in the dry season that the rain can’t explain.'
	}
];

/** The fields the node table shows as columns; the one-node form shows every field. */
export const TABLE_FIELDS: NodeField[] = NODE_FIELDS.filter((f) => !f.detailOnly);

/**
 * Write a numeric field from its input. The fields the engine added later
 * (boreholes, WP-1.34) are optional on NetworkNode, so the form writes
 * through this rather than binding the union directly.
 */
export function setNodeField(node: NetworkNode, key: NodeNumberKey, v: number | null): void {
	(node as unknown as Record<NodeNumberKey, number | null>)[key] = v;
}

/**
 * A field's label on the node table's phone cards (≤ 640 px), where the group
 * header row ("Dam", "Irrigation") is gone: "Dam capacity", "Dam initial storage".
 */
export function cardLabel(f: NodeField): string {
	if (f.group === 'area') return f.key === 'areaKm2' ? f.label : `${f.label} area`;
	if (f.group === 'dam') return f.key === 'damInitialPct' ? 'Dam initial storage' : `Dam ${f.label.toLowerCase()}`;
	return f.label;
}

export const isPct = (f: NodeField) => f.unit === '%' || f.unit === '%/day' || f.unit === '% of supply';
/** What a field's input multiplies the stored value by to show it. */
export const fieldScale = (f: NodeField) => (isPct(f) ? 100 : (f.scale ?? 1));

/** Why a field isn't used on this node (fieldUnused): one id per reason, so the form can name each reason once. */
export type UnusedReason = 'onRiver' | 'outlet' | 'noLoss' | 'noDam';

const UNUSED_TEXT: Record<UnusedReason, string> = {
	onRiver: 'Not available: the dam is on the river (Upstream inflow to dam is 100 %). River to dam fills an off-channel dam; set Upstream inflow to dam below 100 % to use it.',
	outlet: 'Not used: the outlet has no reach below it in the model.',
	noLoss: 'Not used: no bed losses (the share is 0 %). Enter a share to cap it.',
	noDam: 'Not used: no dam (capacity 0). Enter a capacity to use it.'
};

type UnusedNode = Pick<NetworkNode, 'pctUpstreamToDam'> & Partial<Pick<NetworkNode, 'damCapacityM3' | 'downstreamNodeId' | 'reachLossFrac'>>;

/** fieldUnused's reason, as an id. */
export function unusedReason(f: NodeField, n: UnusedNode, form = false): UnusedReason | null {
	if (f.key === 'divertCapacityM3Day' && onRiverDam(n)) return 'onRiver'; // gitleaks:allow (a field name, not a secret)
	// Bed losses (engine ≥ 1.75.0) are in the reach below: none below the outlet. One left there stays editable so it can be cleared.
	if (f.group === 'reach' && n.downstreamNodeId === null && !((n.reachLossFrac ?? 0) > 0)) return 'outlet';
	if (f.key === 'reachLossMaxM3Day' && !((n.reachLossFrac ?? 0) > 0)) return 'noLoss';
	if (!form) return null;
	if (f.group === 'dam' && f.key !== 'damCapacityM3' && !((n.damCapacityM3 ?? 0) > 0)) return 'noDam';
	return null;
}

/**
 * Why a field isn't used on this node, or null; the field then shows
 * read-only with this as its hint, its stored value kept. River to dam on a
 * dam on the river (engine ≥ 1.68.0, onRiverDam). In the one-node form
 * (`form`) also a dam's own fields on a unit with no dam (capacity 0, as the
 * engine reads it). The node table keeps those editable, so a block pasted or
 * typed across a row lands whole.
 */
export function fieldUnused(f: NodeField, n: UnusedNode, form = false): string | null {
	const r = unusedReason(f, n, form);
	return r ? UNUSED_TEXT[r] : null;
}

/** One reason's line in the one-node form (issue #521): what it is, then what would make the fields count. */
export function unusedLine(r: UnusedReason): { why: string; fix: string } {
	switch (r) {
		case 'onRiver':
			return { why: 'Not available on a dam on the river (Upstream inflow to dam is 100 %)', fix: 'River to dam fills an off-channel dam; set Upstream inflow to dam below 100 % to use it.' };
		case 'outlet':
			return { why: 'Not used at the outlet, which has no reach below it in the model', fix: '' };
		case 'noLoss':
			return { why: 'Not used with no bed losses (the share is 0 %)', fix: 'Enter a share to cap it.' };
		case 'noDam':
			return { why: 'Not used without a dam (capacity 0)', fix: 'Enter a capacity to use these.' };
	}
}

/**
 * A section's fields as the one-node form lays them out (issue #521): the
 * ones people change first, the rarely changed ones under "More … settings"
 * (`more`), and the ones this node doesn't use, by reason, behind one
 * "Not used …" line each instead of drawn greyed out.
 */
export function splitFields(fields: readonly NodeField[], n: UnusedNode, form = false): { main: NodeField[]; more: NodeField[]; unused: { reason: UnusedReason; fields: NodeField[] }[] } {
	const main: NodeField[] = [];
	const more: NodeField[] = [];
	const unused: { reason: UnusedReason; fields: NodeField[] }[] = [];
	for (const f of fields) {
		const r = unusedReason(f, n, form);
		if (r) {
			const g = unused.find((u) => u.reason === r);
			if (g) g.fields.push(f);
			else unused.push({ reason: r, fields: [f] });
		} else (f.more ? more : main).push(f);
	}
	return { main, more, unused };
}

/** A node's kind in the workspace's words (playbook § 3: a farm is a hydrological unit here). */
export const KIND_WORD: Record<NodeKind, string> = { farm: 'hydrological unit', gauge: 'gauge', user: 'other water user' };

/** Volume fields (m³, m³/day) hold six- or seven-digit values, so their table columns need room for them. */
export const isVolume = (f: NodeField) => f.unit === 'm³' || f.unit === 'm³/day';

/**
 * Hints (not errors) about a node's dam settings, shown under its fields.
 * A dam with no minimum operating level can be emptied by irrigation, which
 * the workbook allowed but few farmers do (docs/engine-audit.md Q5).
 */
export function damHints(n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'damMinPct'> & Partial<Pick<NetworkNode, 'damAreaFullM2' | 'damCurve'>>): string[] {
	if (!hasDam(n)) return [];
	const hints: string[] = [];
	if (!(n.damMinPct > 0)) hints.push('Irrigation may empty this dam: its minimum operating level is 0 %.');
	// A survey curve (WP-3.5) gives the area; the estimate is only for the power law.
	if ((n.damAreaFullM2 === null || n.damAreaFullM2 === undefined) && !(n.damCurve && n.damCurve.length))
		hints.push(`No surface area: evaporation uses 7.2 × capacity^0.77 m², about ${fmtArea(estimatedDamAreaM2(n.damCapacityM3))}. Enter the dam's area when full for a better figure.`);
	return hints;
}

/**
 * Whether a node carries any of a dam's development fields (engine ≥ 1.30.0:
 * survey date, sediment rate, in-service date), so the one-node form still
 * shows them on a node without a dam, or one turned into a gauge or user,
 * where they can be cleared (the save refuses them off a farm).
 */
export const hasDamDevelopment = (n: Pick<NetworkNode, 'damSurveyDate' | 'damSedimentPctPerYear' | 'damInServiceFrom'>) =>
	!!n.damSurveyDate || (n.damSedimentPctPerYear !== null && n.damSedimentPctPerYear !== undefined) || !!n.damInServiceFrom;

/** Treat a dam under 1 m³ as no dam (the workbook uses tiny placeholders under 1 m³ such as 0.5). */
export const hasDam = (n: Pick<NetworkNode, 'kind' | 'damCapacityM3'>) => n.kind === 'farm' && n.damCapacityM3 >= 1;

/** 30 000 → "3.0 ha"; 5 000 → "5 000 m²". */
function fmtArea(m2: number): string {
	return m2 >= 10_000 ? `${(m2 / 10_000).toFixed(1)} ha` : `${fmtNum(m2)} m²`;
}

/** 2 400 000 → "2.40 Mm³"; 60 000 → "60 000 m³". */
export function fmtVolume(m3: number): string {
	if (m3 >= 100_000) return `${(m3 / 1e6).toFixed(2)} Mm³`;
	return `${fmtNum(m3)} m³`;
}

/**
 * Under a unit's return flow when it is more than its losses (engine ≥ 1.71.0):
 * the efficiency `e` is its crops' irrigation systems blended (1.72.0), which a
 * crop's system or the systems' table can move from another screen, so this is
 * a warning, not a refusal; a run returns the losses, 1 − e, and says so. Null
 * when the return flow fits.
 */
export function returnFlowHint(returnFlow: number, e: number): string | null {
	if (!(returnFlow > 1 - e + RETURN_FLOW_SLACK)) return null;
	const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
	return `Only ${pct(1 - e)} of the water supplied is lost at its ${pct(e)} irrigation efficiency (its crops' systems), so runs return ${pct(1 - e)}, not ${pct(returnFlow)}. Lower it to match, or check its crops' systems.`;
}

/** A dam outline linked to the unit on the map, as `GET …/map/linked-nodes` gives it (194 dam_position; null = not said). */
export interface DamSiting {
	name: string;
	damPosition: 'on_channel' | 'off_channel' | null;
}

const SITING_WORD: Record<'on_channel' | 'off_channel', string> = { on_channel: 'on the river', off_channel: 'off-channel' };

/**
 * What the map says of the unit's dam beside its Upstream inflow to dam: each linked dam outline's Siting, and a warning
 * when the share contradicts it (docs/maps.md § Start from the map, model.md §2.7 K). Start and Divide propose 0 % for an
 * off-channel dam and 100 % for one on the river, but the share is edited here by hand, so the two can drift. A warning,
 * never a block, and only at the share that is plainly the other kind: off-channel with 100 % (the river runs through the
 * dam, and River to dam isn't available), or on the river with 0 % (the river passes it by). A share in between can be a
 * unit lumping several dams, so it isn't questioned; nor is a unit whose outlines aren't all marked alike, or one with no dam.
 * Null when no dam outline is linked to the unit.
 */
export function damSitingHint(dams: readonly DamSiting[], n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'pctUpstreamToDam'>): { line: string; warning: string | null } | null {
	if (!dams.length) return null;
	const said = (d: DamSiting) => (d.damPosition ? `marked ${SITING_WORD[d.damPosition]}` : 'not said whether on the river or off it');
	const name = (d: DamSiting) => (d.name.trim() ? `“${d.name.trim()}”` : '(unnamed)');
	const line =
		dams.length === 1
			? `On the map, its dam ${name(dams[0]!)} is ${said(dams[0]!)}${dams[0]!.damPosition ? '' : ' (its Siting on the map)'}.`
			: `On the map, its dams: ${dams.map((d) => `${name(d)} ${said(d).replace(/^marked /, '')}`).join('; ')}.`;
	const position = dams[0]!.damPosition;
	if (!position || !hasDam(n) || dams.some((d) => d.damPosition !== position)) return { line, warning: null };
	const share = n.pctUpstreamToDam;
	const one = dams.length === 1;
	if (position === 'off_channel' && share >= 1 - 1e-9)
		return {
			line,
			warning: `The map marks ${one ? 'this dam' : 'these dams'} off-channel, but Upstream inflow to dam is 100 %: a run takes the whole river through the dam, and River to dam isn’t available. An off-channel dam takes 0 % and fills from its own runoff and River to dam. Change the share here, or the Siting on the map.`
		};
	if (position === 'on_channel' && share <= 1e-9)
		return {
			line,
			warning: `The map marks ${one ? 'this dam' : 'these dams'} on the river, but Upstream inflow to dam is 0 %: a run passes the whole river by the dam. A dam on the river takes 100 %. Change the share here, or the Siting on the map.`
		};
	return { line, warning: null };
}
