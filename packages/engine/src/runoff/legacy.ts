// The legacy rain → flow model: the b023 [Flow data] recession model
// (../flow.ts), unchanged. Kept as the comparison baseline until the
// hydrologist signs off its replacement (issue #4, roadmap WP-1.25); it does
// not conserve water at the event scale (docs/engine-audit.md H1).
import { computeNaturalFlow, recessionTableWarnings } from '../flow';
import { requireCatchmentAreaKm2 } from './area';
import type { NaturalFlowGenerator } from './types';

export const legacyNaturalFlow: NaturalFlowGenerator = (input, ctx) => {
	const cal = { ...ctx.settings.calibration, catchmentAreaKm2: requireCatchmentAreaKm2(ctx.settings.calibration, input) };
	const nf = computeNaturalFlow(cal, {
		startDate: ctx.startDate,
		days: ctx.days,
		rainCatchmentMm: ctx.aligned('rain_catchment_mm'),
		rainChirpsMm: ctx.aligned('rain_chirps_mm'),
		rainForecastMm: ctx.aligned('rain_forecast_mm')
	});
	return { ...nf, warnings: recessionTableWarnings(ctx.settings.calibration) };
};
