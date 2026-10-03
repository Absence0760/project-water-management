// The numeric node fields, in the order the editor shows them, with units and
// plain-language help. Percent fields are stored 0–1 and shown as %.
import { areaMismatches, estimatedDamAreaM2, IRRIGATION_SYSTEMS, onRiverDam, type FlowShareMethod, type IrrigationSystemId, type NetworkNode, type NodeKind } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

export type NodeNumberKey =
	| 'areaKm2'
	| 'areaHiKm2'
	| 'areaLoKm2'
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
	| 'lossReturnFraction'
	| 'flowShareManual'
	| 'boreholeCapacityM3Day'
	| 'boreholeTriggerPct'
	| 'streamDepletionFrac'
	| 'streamDepletionLagDays'
	| 'gaPropertyAreaHa';

export interface NodeField {
	key: NodeNumberKey;
	/** Short column / field label. */
	label: string;
	unit: 'km²' | 'm³' | 'm²' | '%' | '%/day' | 'm³/day' | 'm³/s' | '×' | 'days' | 'ha';
	/** Shown = stored × scale, for a field entered in another unit than it is stored in (m³/s stored as m³/day). Percentages scale by 100 on their own. */
	scale?: number;
	group: 'area' | 'dam' | 'routing' | 'irrigation' | 'share' | 'groundwater';
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
}

/** m³/day → m³/s: River to dam is entered in m³/s and stored in m³/day. */
export const M3S_PER_M3DAY = 1 / 86_400;

export const GROUPS: Record<NodeField['group'], string> = {
	area: 'Catchment area',
	dam: 'Dam',
	routing: 'Routing',
	irrigation: 'Irrigation',
	share: 'Flow share',
	groundwater: 'Combined boreholes (one capacity)'
};

export const NODE_FIELDS: NodeField[] = [
	{
		key: 'areaKm2',
		label: 'Area',
		unit: 'km²',
		group: 'area',
		aria: (n) => `Area of ${n}, km²`,
		help: "The node's own runoff area, excluding nodes upstream of it. Hydrological unit areas set the area-based flow shares and add up to the catchment area."
	},
	{
		key: 'areaHiKm2',
		label: 'High-MAP',
		unit: 'km²',
		group: 'area',
		aria: (n) => `High-MAP area of ${n}, km²`,
		help: 'Part of the area in the high-rainfall (high mean annual precipitation) zone. Only used by the high/low MAP flow-share method.'
	},
	{
		key: 'areaLoKm2',
		label: 'Low-MAP',
		unit: 'km²',
		group: 'area',
		aria: (n) => `Low-MAP area of ${n}, km²`,
		help: 'Part of the area in the low-rainfall zone. Only used by the high/low MAP flow-share method.'
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
		help: 'Share of the water arriving from upstream nodes that enters the dam. 100 %: a dam on the river, which catches it all, and has no River to dam. 0 %: an off-channel dam, which the river passes by; it fills from its share of the runoff and from River to dam. (The b023 workbook\'s formula applied it the other way round; the import converts its values, see docs/model.md §3 Q1.)'
	},
	{
		key: 'pctRunoffToDam',
		label: 'Runoff to dam',
		unit: '%',
		group: 'routing',
		farmOnly: true,
		aria: (n) => `Own runoff entering the dam at ${n}, %`,
		help: "Share of the hydrological unit's own runoff that enters the dam (the part of its area above the dam wall). The rest flows past below the dam."
	},
	{
		key: 'divertCapacityM3Day',
		label: 'River to dam',
		unit: 'm³/s',
		scale: M3S_PER_M3DAY,
		group: 'routing',
		farmOnly: true,
		aria: (n) => `River to dam at ${n}, m³/s`,
		help: 'Most water taken from the river into an off-channel dam, by a weir, furrow or pump, in m³/s (0.2 m³/s = 17 280 m³ a day). Not available for a dam on the river (Upstream inflow to dam 100 %). It takes up to this every day of the year (or set it by month below), leaving in the river what senior water users downstream need, and the hands-off flow under Supply when there is one; without one it doesn’t leave the EWR. This is separate from the river pump under Supply, which irrigates: if one pump does both, split its capacity between the two. 0 means none.'
	},
	{
		key: 'irrigationEfficiency',
		label: 'Efficiency',
		unit: '%',
		group: 'irrigation',
		farmOnly: true,
		aria: (n) => `Irrigation efficiency of ${n}, %`,
		help: 'Share of the water abstracted that reaches the crop. The hydrological unit abstracts crop requirement ÷ efficiency. Must be above 0 %; 100 % means no application losses.'
	},
	{
		key: 'lossReturnFraction',
		label: 'Losses returning',
		unit: '%',
		group: 'irrigation',
		farmOnly: true,
		aria: (n) => `Share of irrigation losses returning to the river at ${n}, %`,
		help: 'Share of the application losses that drains back to the river below the hydrological unit the same day (return flow). The rest leaves the catchment.'
	},
	{
		key: 'flowShareManual',
		label: 'Manual',
		unit: '%',
		group: 'share',
		farmOnly: true,
		nullable: true,
		aria: (n) => `Manual flow share of ${n}, %`,
		help: "This hydrological unit's share of catchment natural flow and of the EWR. Only used when the flow-share method (Settings & calibration) is Manual; hydrological unit shares should add up to 100 %."
	},
	{
		key: 'boreholeCapacityM3Day', // gitleaks:allow (a field name, not a secret)
		detailOnly: true,
		notGauge: true,
		label: 'Combined borehole capacity',
		unit: 'm³/day',
		group: 'groundwater',
		nullable: true,
		aria: (n) => `Combined borehole capacity of ${n}, m³/day`,
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
		detailOnly: true,
		notGauge: true,
		label: 'Property area (GN 538)',
		unit: 'ha',
		group: 'groundwater',
		nullable: true,
		aria: (n) => `GN 538 property area of ${n}, ha`,
		help: 'Size of the property the groundwater is taken on (land registered separately in a Deeds Office). With the Table 2 rate below it gives the general authorisation’s volume for the property, for context only.'
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
 * header row ("Dam", "Flow share") is gone: "Dam capacity", "High-MAP area".
 */
export function cardLabel(f: NodeField): string {
	if (f.group === 'area') return f.key === 'areaKm2' ? f.label : `${f.label} area`;
	if (f.group === 'dam') return f.key === 'damInitialPct' ? 'Dam initial storage' : `Dam ${f.label.toLowerCase()}`;
	if (f.group === 'share') return `${f.label} flow share`;
	return f.label;
}

export const isPct = (f: NodeField) => f.unit === '%' || f.unit === '%/day';
/** What a field's input multiplies the stored value by to show it. */
export const fieldScale = (f: NodeField) => (isPct(f) ? 100 : (f.scale ?? 1));

/**
 * Why a field isn't used on this node, or null; the field then shows
 * read-only with this as its hint, its stored value kept. River to dam on a
 * dam on the river (engine ≥ 1.68.0, onRiverDam). In the one-node form, which
 * passes the flow-share method: a dam's own fields on a unit with no dam
 * (capacity 0, as the engine reads it), the high/low MAP areas unless the
 * method is the high/low MAP split, and the manual share unless it is manual.
 * The node table passes no method and keeps those editable, so a block pasted
 * or typed across a row lands whole.
 */
export function fieldUnused(f: NodeField, n: Pick<NetworkNode, 'pctUpstreamToDam'> & Partial<Pick<NetworkNode, 'damCapacityM3'>>, method?: FlowShareMethod): string | null {
	if (f.key === 'divertCapacityM3Day' && onRiverDam(n)) // gitleaks:allow (a field name, not a secret)
		return 'Not available: the dam is on the river (Upstream inflow to dam is 100 %). River to dam fills an off-channel dam; set Upstream inflow to dam below 100 % to use it.';
	if (!method) return null;
	if (f.group === 'dam' && f.key !== 'damCapacityM3' && !((n.damCapacityM3 ?? 0) > 0)) return 'Not used: no dam (capacity 0). Enter a capacity to use it.';
	if ((f.key === 'areaHiKm2' || f.key === 'areaLoKm2') && method !== 'hiLo')
		return 'Not used: the flow-share method isn’t the high/low MAP split (Settings & calibration). Pick it there to use this.';
	if (f.key === 'flowShareManual' && method !== 'manual') return 'Not used: the flow-share method isn’t Manual (Settings & calibration). Pick it there to use this.';
	return null;
}

/**
 * Under the high/low MAP areas while that method is in use: their sum against
 * the unit's area, by the rule the run checks after it has run (engine
 * quality.ts areaMismatches, more than 1 % apart), so it is caught while
 * typing. Null when they agree.
 */
export function hiLoHint(n: NetworkNode): string | null {
	const m = areaMismatches([n], 'hiLo')[0];
	if (!m) return null;
	return `High-MAP + Low-MAP = ${fmtNum(m.hiLoKm2, 2)} km², but the area is ${fmtNum(m.areaKm2, 2)} km²: they should add up to it.`;
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
 * The irrigation system whose SABI 2021 efficiency (IRRIGATION_SYSTEMS) this
 * value is, for the node form's helper; null for any other value (a farm
 * saved with an efficiency from before the table was unified, 0.65 say,
 * shows "Other" and keeps its value).
 */
export function systemOf(efficiency: number): IrrigationSystemId | null {
	return IRRIGATION_SYSTEMS.find((s) => Math.abs(s.efficiency - efficiency) < 1e-9)?.id ?? null;
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
