// Gross irrigation demand preview per farm, from the engine's own helper so
// the numbers match what a run will use (before the daily effective-rain
// reduction, which needs the rainfall series).
import {
	daysPerMonth,
	grossFarmDemandM3PerDay,
	type Crop,
	type Monthly,
	type ProjectModel
} from '@water-management/engine';

export interface FarmDemand {
	nodeId: string;
	/** Gross demand per water-year month (Oct–Sep), m³/day. */
	monthlyM3Day: number[];
	/** Mean over the year, m³/day (days-weighted). */
	meanM3Day: number;
	/** Annual volume, million m³ (Mm³/a). */
	annualMm3: number;
	/** Cropped area, ha. */
	areaHa: number;
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
	return nodeIds.map((nodeId) => {
		const areas = new Map<string, number>();
		let areaM2 = 0;
		for (const a of model.cropAreas) {
			if (a.nodeId !== nodeId) continue;
			areas.set(a.cropId, (areas.get(a.cropId) ?? 0) + a.areaM2);
			areaM2 += a.areaM2;
		}
		const monthly = [...grossFarmDemandM3PerDay(apanMm as unknown as Monthly, crops, areas, februaryDays)];
		const annual = annualMm3(monthly, februaryDays);
		return { nodeId, monthlyM3Day: monthly, meanM3Day: (annual * 1e6) / yearDays, annualMm3: annual, areaHa: areaM2 / 10_000 };
	});
}
