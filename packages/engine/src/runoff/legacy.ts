// The legacy rain → flow model: the b023 [Flow data] recession model
// (../flow.ts), unchanged. Kept as the comparison baseline until the
// hydrologist signs off its replacement (issue #4, roadmap WP-1.25); it does
// not conserve water at the event scale (docs/engine-audit.md H1).
import { computeNaturalFlow, recessionTableWarnings } from '../flow';
import type { CalibrationParams } from '../project';
import { requireCatchmentAreaKm2 } from './area';
import type { NaturalFlowGenerator, ParamSpec } from './types';

/**
 * The legacy parameters automatic calibration may fit (./calibrate), with the
 * bounds it searches. The rain threshold is left out on purpose: it also
 * decides which rain days reduce irrigation demand, so it isn't a runoff
 * parameter alone. The recession tables stay as imported.
 */
export const LEGACY_PARAMS: ParamSpec<CalibrationParams>[] = [
	{ key: 'a', label: 'Peak-flow coefficient a', unit: '', default: 0.09, min: 0.001, max: 1, typical: [0.01, 0.3] },
	{ key: 'b', label: 'Peak-flow exponent b', unit: '', default: 1.2, min: 0.5, max: 2.5, typical: [1, 1.5] },
	{ key: 'summerFactor', label: 'Summer factor', unit: '', default: 0.1, min: 0, max: 1, typical: [0.05, 0.5] },
	{ key: 'winterFactor', label: 'Winter factor', unit: '', default: 1, min: 0, max: 2, typical: [0.5, 1.5] },
	{ key: 'baseResetRatio', label: 'Base-flow reset ratio', unit: '', default: 1.5, min: 1, max: 5, typical: [1.2, 2], fixedByDefault: true }
];

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
