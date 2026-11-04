// What a land unit's CHIRPS driver would run as (settings.unitRain.chirpsUnits,
// engine ≥ 1.114.0, docs/model.md §2.4h *CHIRPS as a unit's driver*), for
// Settings → Flow generation: the unit's MAP, its CHIRPS mean annual rain and
// the factor beside the choice, from the code a run uses (unitRainRecipes over
// the stored model input), so the form and a run of the same input can't
// disagree. Computed when viewed, never stored; changes no run output.
import { cmpStr } from '../order';
import { prepareRun, type PreparedRun } from '../prepare';
import { DEFAULT_UNIT_RAIN, resolveUnitRain, type ModelInput, type UnitChirpsChoice, type UnitChirpsLevel, type UnitRainSettings } from '../project';
import { isLandUnit } from './area';
import { unitRainRecipes } from './unitRain';

export interface UnitChirpsPreview {
	/** Whether the choice applies: the unit has usable CHIRPS of its own (else it runs as without the choice). */
	applies: boolean;
	/** How its CHIRPS would be levelled under the choice (null: no CHIRPS series of its own). */
	level: UnitChirpsLevel | null;
	/** The run's warnings about the unit, in the run's words. */
	warnings: string[];
}

/**
 * Each land unit of `chirpsUnits` → what its choice would run as, over the stored model input `input` (its series,
 * nodes and settings, with `chirpsUnits` in place of the stored choices and those units' station assignments left
 * out, as the form saves them). `unitRain`, the form's unsaved setting (its reference gauge, MAP period and gauge
 * MAP), replaces the stored one when given. Units the model doesn't have as land units are left out.
 */
export function unitChirpsChoicePreview(
	input: ModelInput,
	chirpsUnits: Readonly<Record<string, UnitChirpsChoice>>,
	prep: PreparedRun = prepareRun(input),
	unitRain?: UnitRainSettings | null
): Record<string, UnitChirpsPreview> {
	const ids = Object.keys(chirpsUnits).sort(cmpStr);
	const rs = prep.settings.rainStations;
	const units = rs?.units ? Object.fromEntries(Object.entries(rs.units).filter(([id]) => !(id in chirpsUnits))) : undefined;
	const settings = {
		...prep.settings,
		unitRain: { ...(unitRain !== undefined ? resolveUnitRain(unitRain, []) : (prep.settings.unitRain ?? DEFAULT_UNIT_RAIN)), chirpsUnits: structuredClone(chirpsUnits) as Record<string, UnitChirpsChoice> },
		...(rs ? { rainStations: { ...rs, ...(units ? { units } : {}) } } : {})
	};
	const warnings: string[] = [];
	const recipes =
		unitRainRecipes(
			{ settings, series: input.series, nodes: input.model.nodes, chirpsCorrection: prep.chirpsCorrection, stations: prep.stations?.context ?? null, stationInputs: input.stations ?? null },
			warnings
		) ?? [];
	const out: Record<string, UnitChirpsPreview> = {};
	for (const id of ids) {
		const node = input.model.nodes.find((n) => n.id === id);
		const r = recipes.find((x) => x.nodeId === id);
		if (!node || !isLandUnit(node) || !r) continue;
		const named = `"${node.name}"`;
		out[id] = { applies: r.chirpsChoice !== undefined, level: r.chirps ? structuredClone(r.chirps) : null, warnings: warnings.filter((w) => w.includes(named)) };
	}
	return out;
}
