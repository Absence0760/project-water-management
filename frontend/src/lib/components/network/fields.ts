// The numeric node fields, in the order the editor shows them, with units and
// plain-language help. Percent fields are stored 0–1 and shown as %.
import type { NetworkNode } from '@water-management/engine';

export type NodeNumberKey =
	| 'areaKm2'
	| 'areaHiKm2'
	| 'areaLoKm2'
	| 'damCapacityM3'
	| 'damInitialPct'
	| 'damMinPct'
	| 'pctUpstreamToDam'
	| 'pctRunoffToDam'
	| 'divertCapacityM3Day'
	| 'returnFlowPct'
	| 'flowShareManual';

export interface NodeField {
	key: NodeNumberKey;
	/** Short column / field label. */
	label: string;
	unit: 'km²' | 'm³' | '%' | 'm³/day';
	group: 'area' | 'dam' | 'routing' | 'share';
	/** Accessible name in the table, where each row repeats the field: "Area of Hilltop farm, km²". */
	aria: (name: string) => string;
	help: string;
	/** Farm-only: gauges only pass upstream flow through. */
	farmOnly?: boolean;
	nullable?: boolean;
}

export const GROUPS: Record<NodeField['group'], string> = {
	area: 'Catchment area',
	dam: 'Farm dam',
	routing: 'Routing',
	share: 'Flow share'
};

export const NODE_FIELDS: NodeField[] = [
	{
		key: 'areaKm2',
		label: 'Area',
		unit: 'km²',
		group: 'area',
		aria: (n) => `Area of ${n}, km²`,
		help: "The node's own runoff area, excluding nodes upstream of it. Farm areas set the area-based flow shares and add up to the catchment area."
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
		help: 'Full supply capacity of the farm dam. 0 means no dam: demand is met from the river only.'
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
		key: 'pctUpstreamToDam',
		label: 'Upstream inflow to dam',
		unit: '%',
		group: 'routing',
		farmOnly: true,
		aria: (n) => `Upstream inflow entering the dam at ${n}, %`,
		help: 'Share of the water arriving from upstream nodes that enters the dam. The rest passes below it, where the divert capacity can take some back. 100 % suits a dam on the river; 0 % an off-channel dam filled only by the diversion. (The b023 workbook\'s formula applied it the other way round; see docs/model.md §3 Q1.)'
	},
	{
		key: 'pctRunoffToDam',
		label: 'Runoff to dam',
		unit: '%',
		group: 'routing',
		farmOnly: true,
		aria: (n) => `Own runoff entering the dam at ${n}, %`,
		help: "Share of the farm's own runoff that enters the dam (the part of its area above the dam wall). The rest flows past below the dam."
	},
	{
		key: 'divertCapacityM3Day',
		label: 'Divert capacity',
		unit: 'm³/day',
		group: 'routing',
		farmOnly: true,
		aria: (n) => `Divert capacity of ${n}, m³/day`,
		help: 'Most water per day that can be diverted from the river below the dam back into the dam (a weir, furrow or pump). 0 means none.'
	},
	{
		key: 'returnFlowPct',
		label: 'Return flow',
		unit: '%',
		group: 'routing',
		farmOnly: true,
		aria: (n) => `Return flow of ${n}, %`,
		help: 'Share of the irrigation water supplied that runs back to the river below the farm.'
	},
	{
		key: 'flowShareManual',
		label: 'Manual',
		unit: '%',
		group: 'share',
		farmOnly: true,
		nullable: true,
		aria: (n) => `Manual flow share of ${n}, %`,
		help: "This farm's share of catchment natural flow and of the EWR. Only used when the flow-share method (Settings & calibration) is Manual; farm shares should add up to 100 %."
	}
];

export const isPct = (f: NodeField) => f.unit === '%';

/**
 * Hints (not errors) about a node's dam settings, shown under its fields.
 * A dam with no minimum operating level can be emptied by irrigation, which
 * the workbook allowed but few farmers do (docs/engine-audit.md Q5).
 */
export function damHints(n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'damMinPct'>): string[] {
	if (!hasDam(n)) return [];
	const hints: string[] = [];
	if (!(n.damMinPct > 0)) hints.push('Irrigation may empty this dam: its minimum operating level is 0 %.');
	return hints;
}

/** Treat a dam under 1 m³ as no dam (the workbook uses tiny placeholders such as 0.15). */
export const hasDam = (n: Pick<NetworkNode, 'kind' | 'damCapacityM3'>) => n.kind === 'farm' && n.damCapacityM3 >= 1;

/** 1 050 000 → "1.05 Mm³"; 40 000 → "40,000 m³". */
export function fmtVolume(m3: number): string {
	if (m3 >= 100_000) return `${(m3 / 1e6).toFixed(2)} Mm³`;
	return `${Math.round(m3).toLocaleString('en-US')} m³`;
}
