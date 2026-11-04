// What each unit's CHIRPS driver would run as (engine ≥ 1.114.0, docs/model.md §2.4h *CHIRPS as a unit's driver*,
// docs/ui.md § Model settings): the engine's unitChirpsChoicePreview over the input a run would read (GET
// /projects/:id/model-input), with the form's choices in place of the saved ones, for the line beside the Per unit
// table's Driver rainfall select (the unit's MAP, its CHIRPS mean annual rain and the factor). Loaded on demand
// (FlowGenerationUnits imports it when a unit has CHIRPS as its driver), so the engine's run preparation stays out of
// the Settings chunk. The form's unsaved unit-rain setting (reference gauge, MAP period) and CHIRPS bias correction
// stand in for the stored ones, so the line follows the draft. One input per Settings visit, one preparation per bias
// mode: `forgetChirpsDriverPreview` drops them when the table mounts again.
import {
	prepareRun,
	unitChirpsChoicePreview,
	type ChirpsBiasMode,
	type ModelInput,
	type PreparedRun,
	type UnitChirpsChoice,
	type UnitChirpsPreview,
	type UnitRainSettings
} from '@water-management/engine';
import { api } from '#lib/api/index.js';

type Fetchers = { modelInput: (projectId: string) => Promise<ModelInput> };
const API: Fetchers = { modelInput: (id) => api.runs.modelInput(id) };

const inputs = new Map<string, Promise<ModelInput>>();
const preps = new Map<string, Promise<{ input: ModelInput; prep: PreparedRun }>>();

/** Drop a project's held input (the table mounted again: the series or the model may have changed since). */
export function forgetChirpsDriverPreview(projectId: string): void {
	inputs.delete(projectId);
	for (const k of [...preps.keys()]) if (k.startsWith(`${projectId}|`)) preps.delete(k);
}

/** The form's settings the preview reads in place of the stored ones. */
export interface ChirpsDriverDraft {
	unitRain?: UnitRainSettings | null;
	chirpsBiasCorrection?: ChirpsBiasMode | string;
}

/** Unit id → what its CHIRPS driver would run as, over the stored input with `choices` and `draft` in place of the saved ones. */
export async function chirpsDriverPreview(
	projectId: string,
	choices: Readonly<Record<string, UnitChirpsChoice>>,
	draft: ChirpsDriverDraft = {},
	f: Fetchers = API
): Promise<Record<string, UnitChirpsPreview>> {
	let i = inputs.get(projectId);
	if (!i) {
		i = f.modelInput(projectId);
		inputs.set(projectId, i);
		i.catch(() => inputs.get(projectId) === i && inputs.delete(projectId));
	}
	const mode = draft.chirpsBiasCorrection;
	const key = `${projectId}|${mode ?? ''}`;
	let p = preps.get(key);
	if (!p) {
		// The §2.4b factors a bias-corrected unit may take come from the preparation, so it follows the draft's mode.
		p = i.then((stored) => {
			const input = mode ? { ...stored, settings: { ...stored.settings, chirpsBiasCorrection: mode as ChirpsBiasMode } } : stored;
			return { input, prep: prepareRun(input) };
		});
		preps.set(key, p);
		p.catch(() => preps.get(key) === p && preps.delete(key));
	}
	const { input, prep } = await p;
	return unitChirpsChoicePreview(input, choices, prep, draft.unitRain === undefined ? undefined : draft.unitRain);
}
