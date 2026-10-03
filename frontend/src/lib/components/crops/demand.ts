// Irrigation demand preview per farm, from the engine's own helpers so the
// numbers match what a run will use (before the daily effective-rain
// reduction, which needs the rainfall series): the crops' gross requirement
// divided by the unit's irrigation efficiency, the water it abstracts for them
// (audit N1, docs/model.md §2.3).
import {
	daysPerMonth,
	farmIrrigationEfficiency,
	grossFarmDemandM3PerDay,
	ownCropEfficiency,
	type Crop,
	type Monthly,
	type ProjectModel
} from '@water-management/engine';

export interface FarmDemand {
	nodeId: string;
	/** Demand per water-year month (Oct–Sep), m³/day: the gross crop requirement ÷ `efficiency`. */
	monthlyM3Day: number[];
	/** The efficiency a run divides this unit's requirement by (its own, weighted by its crops' systems). */
	efficiency: number;
	/** Mean over the year, m³/day (days-weighted). */
	meanM3Day: number;
	/** Annual volume, million m³ (Mm³/a). */
	annualMm3: number;
	/** Cropped area, ha. */
	areaHa: number;
	/** The same monthly demand split by crop (crop id → m³/day per month); sums to monthlyM3Day. */
	byCrop: Map<string, number[]>;
}

/** Annual volume (Mm³/a) of a monthly m³/day profile. */
export function annualMm3(monthlyM3Day: readonly number[], februaryDays = 28.25): number {
	const days = daysPerMonth(februaryDays);
	return monthlyM3Day.reduce((s, v, m) => s + v * days[m]!, 0) / 1e6;
}

export function farmDemands(
	model: ProjectModel,
	apanMm: readonly number[],
	februaryDays = 28.25,
	nodeIds: string[] = model.nodes.map((n) => n.id)
): FarmDemand[] {
	const crops: Crop[] = model.crops.map((c) => ({
		id: c.id,
		name: c.name,
		cropFactor: c.cropFactor as unknown as Monthly
	}));
	const yearDays = daysPerMonth(februaryDays).reduce((a, b) => a + b, 0);
	const byId = new Map(model.nodes.map((n) => [n.id, n]));
	return nodeIds.map((nodeId) => {
		const areas = new Map<string, number>();
		let areaM2 = 0;
		for (const a of model.cropAreas) {
			if (a.nodeId !== nodeId) continue;
			areas.set(a.cropId, (areas.get(a.cropId) ?? 0) + a.areaM2);
			areaM2 += a.areaM2;
		}
		const apan = apanMm as unknown as Monthly;
		// One efficiency per unit, as a run uses: a farm's own (a value outside (0, 1] runs as 1) blended
		// with its crops' systems; a non-farm with crop areas abstracts its requirement (e = 1).
		const node = byId.get(nodeId);
		const e = node?.kind === 'farm' ? farmIrrigationEfficiency(ownCropEfficiency(node.irrigationEfficiency) ?? 1, model.crops, areas, apan) : 1;
		const monthly = grossFarmDemandM3PerDay(apan, crops, areas, februaryDays).map((v) => v / e);
		// The engine sums area × gross over crops, so one crop at a time splits it exactly.
		const byCrop = new Map<string, number[]>();
		for (const c of crops) {
			if (!areas.get(c.id)) continue;
			byCrop.set(c.id, grossFarmDemandM3PerDay(apan, [c], areas, februaryDays).map((v) => v / e));
		}
		const annual = annualMm3(monthly, februaryDays);
		return {
			nodeId,
			monthlyM3Day: monthly,
			efficiency: e,
			meanM3Day: (annual * 1e6) / yearDays,
			annualMm3: annual,
			areaHa: areaM2 / 10_000,
			byCrop
		};
	});
}

/**
 * The demand chart's note when the project has a daily A-pan series (issue
 * #173): the preview multiplies the monthly A-pan means, while a run uses the
 * daily series on the days it has a value and these means only on the others
 * (docs/model.md §2.3a), so a run's demand differs. null without a series.
 */
export function demandApanNote(apanDaily: boolean): string | null {
	return apanDaily
		? 'Shows the monthly A-pan means. Runs use the daily A-pan series (Data tab) on the days it has a value and these means only on the other days, so their demand differs.'
		: null;
}

/**
 * The demand alert's opening when no monthly A-pan mean is set but a daily
 * A-pan series exists (issue #173): the preview shows no demand, yet runs
 * take the series on the days it covers. A link to Settings follows it.
 */
export const DAILY_APAN_NO_MEANS =
	"The monthly A-pan means aren't set, so this preview shows no demand. Runs use the daily A-pan series (Data tab) on the days it has a value.";

/**
 * Crops with a factor above 1.0 in any month, with those months (water-year
 * labels). The engine multiplies the factor by A-pan evaporation, not by FAO
 * reference ET₀ (about 0.6–0.85 × pan; 0.35–0.85 in FAO-56 Table 5), so a factor above 1 means the crop
 * uses more water than an open pan loses: possible, but more likely an FAO-56
 * Kc entered as it is. A hint for the Crops tab, never an error.
 */
export function highCropFactors(
	crops: readonly { id: string; name: string; cropFactor: readonly number[] }[],
	monthLabels: readonly string[]
): { id: string; name: string; months: string[] }[] {
	return crops.flatMap((c) => {
		const months = c.cropFactor.flatMap((f, i) => (f > 1 ? [monthLabels[i] ?? String(i + 1)] : []));
		return months.length ? [{ id: c.id, name: c.name, months }] : [];
	});
}

/** Catchment totals of the per-farm preview: the Irrigation demand table's footer row. */
export function catchmentDemand(demand: readonly FarmDemand[]): { monthly: number[]; mean: number; annual: number } {
	return {
		monthly: Array.from({ length: 12 }, (_, m) => demand.reduce((s, d) => s + (d.monthlyM3Day[m] ?? 0), 0)),
		mean: demand.reduce((s, d) => s + d.meanM3Day, 0),
		annual: demand.reduce((s, d) => s + d.annualMm3, 0)
	};
}

export interface CropStack {
	/** Crop id, or 'other' for the grouped remainder. */
	id: string;
	name: string;
	/** Catchment gross demand of this crop (or group) per water-year month, m³/day. */
	values: number[];
}

/**
 * The catchment's monthly demand split by crop, for the stacked chart: the
 * parts sum to catchmentDemand(demand).monthly. Crops with no demand are left
 * out. Without `named`, every crop is a part, in crop order. With `named`
 * (the crops with a colour of their own, ranked: cards.ts `cropColouring`),
 * those are the parts in that order, bottom first, and every other crop with
 * demand is summed into one "Other" part on top, so the chart never needs
 * more colours than it has and matches the crop list and the unit bars.
 */
export function cropStacks(
	demand: readonly FarmDemand[],
	crops: readonly { id: string; name: string }[],
	named?: readonly string[]
): CropStack[] {
	const all = crops
		.map((c) => {
			const values = new Array<number>(12).fill(0);
			for (const d of demand) {
				const v = d.byCrop.get(c.id);
				if (v) for (let m = 0; m < 12; m++) values[m]! += v[m] ?? 0;
			}
			return { id: c.id, name: c.name || '(unnamed)', values };
		})
		.filter((s) => s.values.some((v) => v > 0));
	if (!named) return all;
	const byId = new Map(all.map((s) => [s.id, s]));
	const keep = new Set(named);
	const parts = named.flatMap((id) => byId.get(id) ?? []);
	const rest = all.filter((s) => !keep.has(s.id));
	if (rest.length === 0) return parts;
	const other = new Array<number>(12).fill(0);
	for (const s of rest) for (let m = 0; m < 12; m++) other[m]! += s.values[m]!;
	return [...parts, { id: 'other', name: `Other (${rest.length} crop${rest.length === 1 ? '' : 's'})`, values: other }];
}

/** ["A"] → "A"; ["A", "B"] → "A and B"; ["A", "B", "C"] → "A, B and C". */
export function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The note under Planted areas naming farms with no planted area (so their
 * irrigation demand is zero), or null when every farm has some. Lists at most
 * `max` names, then "and N more".
 */
export function noPlantedAreaNote(names: readonly string[], max = 5): string | null {
	if (names.length === 0) return null;
	if (names.length === 1) return `${names[0]} has no planted area, so its irrigation demand counts as zero.`;
	const shown = names.length > max ? [...names.slice(0, max), `${names.length - max} more`] : names;
	return `${joinNames(shown)} have no planted area, so their irrigation demand counts as zero.`;
}
