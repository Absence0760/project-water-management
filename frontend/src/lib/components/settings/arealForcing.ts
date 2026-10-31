// The rain the areal rainfall correction scales (docs/model.md §2.4g), read as a run would read it: the project's
// model input (GET /projects/:id/model-input) with the form's unsaved settings and model in (fit.ts fitInput, which
// cuts the forecast tail as every ordinary run does), prepared by the engine (zero-rain runs, accumulations,
// rain-source periods, the CHIRPS correction), then catchment ?? corrected CHIRPS ?? forecast day by day. Under
// Per unit that is the rain of the units that fall back to the catchment's (rule 4, model.md §2.4h), the only ones
// the correction scales. Loaded on demand by ArealMapHelper.svelte, so the engine's run preparation stays out of
// the Settings chunks.
import { prepareRun, type ModelInput, type ProjectModel, type ProjectSettings } from '@water-management/engine';
import { api } from '#lib/api/index.js';
import { fitInput } from '#lib/calibration/fit.js';
import { forcingRain, type ArealForcing } from './arealFromMap';

export type ArealForcingRead = ({ ok: true } & ArealForcing) | { ok: false; problem: string };

/** The forcing before the correction, or why there is none to divide by. */
export async function readArealForcing(
	projectId: string,
	settings: ProjectSettings,
	model?: ProjectModel,
	fetchInput: (projectId: string) => Promise<ModelInput> = (id) => api.runs.modelInput(id)
): Promise<ArealForcingRead> {
	const server = await fetchInput(projectId);
	let prep: ReturnType<typeof prepareRun>;
	try {
		prep = prepareRun(fitInput(server, settings, model));
	} catch (e) {
		return { ok: false, problem: `The run can’t be prepared: ${e instanceof Error ? e.message : String(e)}.` };
	}
	// A catchment rainfall station already takes its rain to the catchment's MAP, so the run leaves the correction off.
	if (prep.stations?.plan)
		return {
			ok: false,
			problem: 'The catchment runs on a rainfall station scaled to the catchment’s MAP (Rainfall stations on Model settings), so a run doesn’t apply the areal correction.'
		};
	return {
		ok: true,
		startDate: prep.startDate,
		rainMm: forcingRain(prep.aligned('rain_catchment_mm'), prep.aligned('rain_chirps_mm'), prep.aligned('rain_forecast_mm'), prep.days)
	};
}
