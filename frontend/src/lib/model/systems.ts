// A project's irrigation systems in the editor (engine ≥ 1.72.0, docs/model.md
// §2.3, docs/ui.md § Irrigation systems): the table a crop's default and a
// unit's own system for a crop are picked from, and what a unit's efficiency
// then is (its plantings' systems blended, as a run blends them).
import {
	DEFAULT_IRRIGATION_SYSTEMS,
	IRRIGATION_SYSTEMS,
	modelFarmEfficiency,
	type IrrigationSystemDef,
	type ProjectModel
} from '@water-management/engine';

/** The model's table: its own, else the defaults a run would use. */
export function systemsOf(m: Pick<ProjectModel, 'irrigationSystems'>): readonly IrrigationSystemDef[] {
	return m.irrigationSystems ?? DEFAULT_IRRIGATION_SYSTEMS;
}

/** The row a reference names: by id, else (a document's) a SABI preset's key; null when none. */
export function findSystem(m: Pick<ProjectModel, 'irrigationSystems'>, id: string | null | undefined): IrrigationSystemDef | null {
	if (id == null) return null;
	const table = systemsOf(m);
	return table.find((s) => s.id === id) ?? table.find((s) => s.preset === id) ?? null;
}

/** A percentage to one decimal ("90 %", "82.5 %"). */
export const pctText = (v: number) => `${Math.round(v * 1000) / 10} %`;

/** A row as a picker offers it: "Drip, 90 %"; a name that already ends in its efficiency ("Imported, 66 %") as it is. */
export const systemLabel = (s: Pick<IrrigationSystemDef, 'name' | 'efficiency'>) => (s.name.endsWith(pctText(s.efficiency)) ? s.name : `${s.name}, ${pctText(s.efficiency)}`);

/** SABI 2021's range for a row that started as one of its systems ("SABI 90–95 %"), else null. */
export function sabiRange(s: Pick<IrrigationSystemDef, 'preset'>): string | null {
	const p = s.preset ? IRRIGATION_SYSTEMS.find((x) => x.id === s.preset) : undefined;
	return p ? `SABI ${Math.round(p.min * 100)}–${Math.round(p.max * 100)} %` : null;
}

/** How many crops (as their default) and plantings (as a unit's own) name a row. */
export function systemUse(m: Pick<ProjectModel, 'crops' | 'cropAreas'>, id: string): { crops: number; plantings: number } {
	return {
		crops: m.crops.filter((c) => c.irrigationSystemId === id).length,
		plantings: m.cropAreas.filter((a) => a.irrigationSystemId === id && a.areaM2 > 0).length
	};
}

/**
 * A unit's irrigation efficiency as a run takes it: its own (1 outside (0, 1])
 * blended with its plantings' systems, each weighted by its yearly requirement
 * at the project's A-pan; a unit that isn't a farm runs at 1.
 */
export function unitEfficiency(m: ProjectModel, nodeId: string, apanMm: readonly number[]): number {
	const n = m.nodes.find((x) => x.id === nodeId);
	if (n?.kind !== 'farm') return 1;
	const own = n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1;
	return modelFarmEfficiency(own, nodeId, m.crops, m.cropAreas, apanMm, m.irrigationSystems);
}

/** A unit's planted crops (area > 0), each with the system it is on: its own on the unit, else the crop's default; null when none. */
function plantingSystems(m: ProjectModel, nodeId: string): { crop: string; system: IrrigationSystemDef | null }[] {
	return m.cropAreas
		.filter((a) => a.nodeId === nodeId && a.areaM2 > 0)
		.map((a) => {
			const crop = m.crops.find((c) => c.id === a.cropId);
			return { crop: crop?.name || 'unnamed crop', system: findSystem(m, a.irrigationSystemId ?? crop?.irrigationSystemId ?? null) };
		});
}

/**
 * Whether a run uses the unit's own stored efficiency: some planting resolves
 * no system (a crop from before engine 1.72.0, or one set to none), and a run
 * takes the unit's own for it. Then the unit form and the node table let it be
 * edited ("Efficiency for crops with no system"); otherwise the efficiency is
 * only its crops' systems blended, shown as text.
 */
export function ownEfficiencyUsed(m: ProjectModel, nodeId: string): boolean {
	return plantingSystems(m, nodeId).some((p) => p.system === null);
}

/**
 * A unit's crops grouped by their system, in the order first planted: "Drip,
 * 90 %: Citrus, Pasture · Flood / furrow, 70 %: Lucerne", the crops on none
 * last as "No system (its own NN %): …". Null when nothing is planted.
 */
export function plantingSystemsLine(m: ProjectModel, nodeId: string): string | null {
	const rows = plantingSystems(m, nodeId);
	if (!rows.length) return null;
	const groups = new Map<string, { label: string; crops: string[] }>();
	for (const r of rows) {
		const key = r.system?.id ?? '';
		const g = groups.get(key) ?? { label: r.system ? systemLabel(r.system) : '', crops: [] };
		if (!g.crops.includes(r.crop)) g.crops.push(r.crop);
		groups.set(key, g);
	}
	const none = groups.get('');
	groups.delete('');
	const n = m.nodes.find((x) => x.id === nodeId);
	const own = n && n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1;
	const parts = [...groups.values()].map((g) => `${g.label}: ${g.crops.join(', ')}`);
	if (none) parts.push(`No system (its own ${pctText(own)}): ${none.crops.join(', ')}`);
	return parts.join(' · ');
}
