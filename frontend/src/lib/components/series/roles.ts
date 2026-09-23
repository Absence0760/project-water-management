// What the model does with each series kind (see packages/engine run.ts /
// flow.ts), for the Time series tab's explanation and per-series badges.
import type { SeriesMeta } from '@water-management/engine';

export interface KindRole {
	/** Short badge text. */
	role: string;
	help: string;
	/** Drives the simulation (vs. calibration only). */
	driver: boolean;
}

export const KIND_ROLES: Record<string, KindRole> = {
	rain_catchment_mm: {
		role: 'Main rainfall',
		help: 'Daily catchment rainfall (mm). Drives natural flow and reduces irrigation demand on rainy days (effective rainfall).',
		driver: true
	},
	rain_chirps_mm: {
		role: 'Rain gap-filler',
		help: 'CHIRPS satellite rainfall (mm). Used on days the catchment rainfall record is missing.',
		driver: true
	},
	rain_forecast_mm: {
		role: 'Forecast rain',
		help: 'Forecast rainfall (mm). Used only on days both catchment and CHIRPS rainfall are missing, e.g. to run into the coming days.',
		driver: true
	},
	flow_pitman_m3s: {
		role: 'Fallback flow',
		help: 'Pitman naturalised flow (m³/s, WR2012). Used as natural flow on days the rainfall model gives none, and sets the run period when there is no rainfall.',
		driver: true
	},
	flow_observed_m3s: {
		role: 'Calibration target',
		help: 'Observed flow at the outflow gauge (m³/s, daily mean). Not an input to the water balance: runs compare simulated outflow with it (NSE, PBIAS).',
		driver: false
	},
	flow_logger_m3s: {
		role: 'Calibration (fallback)',
		help: 'Logger flow at the outflow gauge (m³/s). Used for calibration only when there is no observed-gauge series.',
		driver: false
	}
};

/**
 * Ids of the series a run actually reads: the first of each kind by name
 * (the backend's DISTINCT ON (kind) … ORDER BY kind, name), and the logger
 * only when there is no observed-gauge series.
 */
export function seriesInUse(list: SeriesMeta[]): Set<string> {
	const first = new Map<string, SeriesMeta>();
	for (const s of [...list].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
		if (!first.has(s.kind)) first.set(s.kind, s);
	}
	if (first.has('flow_observed_m3s')) first.delete('flow_logger_m3s');
	return new Set([...first.values()].map((s) => s.id));
}
