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
		rainForecastMm: ctx.aligned('rain_forecast_mm'),
		flowPitmanM3s: ctx.aligned('flow_pitman_m3s')
	});
	const warnings = recessionTableWarnings(ctx.settings.calibration);
	// [Flow data] AB falls back to Pitman whenever the rain model gives 0, so
	// one series can mix two sources (quirk Q7, audit W5).
	if (nf.pitmanDays > 0) {
		warnings.push(
			`${nf.pitmanDays} days of natural flow are Pitman flow: the rain model gave 0 on those days, so the series mixes two sources`
		);
	}
	return { ...nf, warnings };
};
