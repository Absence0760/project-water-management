// The one-line summaries of the node sheet's folded sections (issue #521):
// each section card's heading says what the section is set to, so a closed
// one still reads ("300 000 m³ · starts 60 % · min 15 % · seepage 0 %/day"),
// and each "More … settings" fold names its fields with their values.
import { hasCropShares, SUPPLY_DEFAULTS, SUPPLY_RULE_LABEL, type NetworkNode } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { pctText } from '#lib/model/systems.js';
import { fieldScale, hasDam, isPct, type NodeField } from './fields';
import type { NodeSection } from './nodeSections';
import { pumpUnit, riverToDamUnit } from './flowUnit.svelte';

/** A number with at most `digits` decimals, trailing zeros dropped. */
const num = (v: number, digits = 2) => fmtNum(v, digits, true);
/** A share stored 0–1, as "12.5 %". */
const pct = (v: number) => `${num(v * 100)} %`;
const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
/** A flow rate stored in m³/day, in the unit picked for its kind. */
const flow = (m3Day: number, unit: { scale: number; label: string }) => `${num(m3Day * unit.scale, unit.label === 'm³/day' ? 0 : 3)} ${unit.label}`;

/** One field's current value in words: "60 %", "75 000 m²", "not set". */
export function fieldValue(f: NodeField, n: NetworkNode): string {
	const v = (n as unknown as Record<string, number | null | undefined>)[f.key];
	if (v === null || v === undefined) return 'not set';
	if (isPct(f)) return `${num(v * 100)} ${f.unit}`;
	const shown = v * fieldScale(f);
	return f.unit === '×' ? num(shown) : `${num(shown, f.unit === 'm³/s' ? 3 : 2)} ${f.unit}`;
}

/** A fold's line: each field's label and value, "Seepage 0 %/day · Area exponent 0.7". */
export const fieldsLine = (fields: readonly NodeField[], n: NetworkNode) => fields.map((f) => `${f.label} ${fieldValue(f, n)}`).join(' · ');

/** What a section's summary reads beyond the node itself. */
export interface SummaryContext {
	/** The unit's natural MAR share in the latest run (0–1); null before a run, or for a node the run didn't have. */
	share: number | null;
	/** The unit's demand objects' names. */
	demandNames: readonly string[];
	boreholes: number;
	coverPatches: number;
	/** The efficiency a run takes (the crops' systems blended); null when not known. */
	efficiency: number | null;
}

/** The line in a section card's heading: what the section is set to now. */
export function sectionSummary(sec: NodeSection, n: NetworkNode, c: SummaryContext): string {
	switch (sec) {
		case 'area': {
			const parts = [`${num(n.areaKm2)} km²`];
			if (n.kind === 'farm') parts.push(n.mapMm == null ? 'MAP not set' : `MAP ${fmtNum(n.mapMm)} mm`);
			return parts.join(' · ');
		}
		case 'share':
			// Each unit's natural MAR share, from the latest run (issue #616): it needs GR4J, so it isn't worked out while editing.
			return c.share === null ? 'After a run' : `${num(c.share * 100)} % in the latest run`;
		case 'dam':
			if (!hasDam(n)) return 'No dam (capacity 0)';
			return `${fmtNum(n.damCapacityM3)} m³ · starts ${pct(n.damInitialPct)} · min ${pct(n.damMinPct)} · seepage ${pct(n.damSeepagePerDay ?? 0)}/day`;
		case 'damSurvey': {
			const curve = n.damCurve?.length ? `survey curve, ${plural(n.damCurve.length, 'row')}` : 'no survey curve';
			const rule = n.damReleaseRule ?? 'none';
			const release = rule === 'none' ? 'no releases' : rule === 'fixed' ? 'a fixed release each month' : 'passes inflow';
			const parts = [curve, release];
			if (n.damSedimentPctPerYear != null) parts.push(`sediment ${pct(n.damSedimentPctPerYear)} a year`);
			if (n.damInServiceFrom) parts.push(`in service from ${n.damInServiceFrom}`);
			const s = parts.join(' · ');
			return s.charAt(0).toUpperCase() + s.slice(1);
		}
		case 'routing': {
			const toDam =
				n.divertMonthlyM3Day != null ? 'by month' : n.divertCapacityM3Day > 0 ? flow(n.divertCapacityM3Day, riverToDamUnit) : 'none';
			return `Upstream to dam ${pct(n.pctUpstreamToDam)} · runoff to dam ${pct(n.pctRunoffToDam)} · river to dam ${toDam}`;
		}
		case 'supply': {
			const rule = n.supplyRule ?? SUPPLY_DEFAULTS.supplyRule;
			const parts = [SUPPLY_RULE_LABEL[rule].charAt(0).toUpperCase() + SUPPLY_RULE_LABEL[rule].slice(1)];
			if (rule !== 'damFirst' && n.kind !== 'user') parts.push(n.pumpCapacityM3Day == null ? 'pump no limit' : `pump ${flow(n.pumpCapacityM3Day, pumpUnit)}`);
			if (hasCropShares(n)) parts.push('crops’ water split between sources');
			else if (n.cropWaterSource === 'river') parts.push('crops from their own river pump');
			if (n.handsOffM3Day != null) parts.push('hands-off flow by month');
			if (n.handsOffEwr) parts.push('leaves the EWR');
			return parts.join(' · ');
		}
		case 'irrigation': {
			const parts = [`Efficiency ${pctText(c.efficiency ?? n.irrigationEfficiency)}`, `return flow ${pct(n.returnFlowFraction)}`];
			if (n.abstractionFrom) parts.push(`starts ${n.abstractionFrom}`);
			return parts.join(' · ');
		}
		case 'demand': {
			const k = c.demandNames.length;
			if (!k) return 'None';
			const names = c.demandNames.slice(0, 3).join(', ');
			return `${plural(k, 'demand object')}: ${names}${k > 3 ? `, and ${fmtNum(k - 3)} more` : ''}`;
		}
		case 'groundwater': {
			const cap = n.boreholeCapacityM3Day;
			if (!cap) return 'None';
			const rule = n.boreholeRule ?? 'supplemental';
			return `${flow(cap, pumpUnit)} · ${rule}${rule === 'drought' ? ` below ${pct(n.boreholeTriggerPct ?? 0)}` : ''}`;
		}
		case 'boreholes':
			return c.boreholes ? plural(c.boreholes, 'borehole') : 'None';
		case 'cover':
			return c.coverPatches ? plural(c.coverPatches, 'patch', 'patches') : 'None';
		case 'baseflow': {
			const loss = n.baseflowLossM3Day ?? 0;
			const gain = n.baseflowGainM3Day ?? 0;
			if (!(loss > 0) && !(gain > 0)) return 'None';
			return [loss > 0 ? `loses ${fmtNum(loss)} m³/day` : null, gain > 0 ? `gains ${fmtNum(gain)} m³/day` : null].filter(Boolean).join(' · ');
		}
		case 'reach': {
			const share = n.reachLossFrac ?? 0;
			if (!(share > 0)) return n.downstreamNodeId === null ? 'None: the outlet has no reach below it' : 'None lost (0 %)';
			return `${pct(share)} lost${n.reachLossMaxM3Day == null ? '' : `, at most ${fmtNum(n.reachLossMaxM3Day)} m³/day`}`;
		}
	}
}
