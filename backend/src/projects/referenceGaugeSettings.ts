// The reference gauge's catchment area (docs/api.md § Projects, docs/ui.md §
// Calibration → Reference gauge for verification): a gauge on a neighbouring
// river (the project's `flow_reference_m3s` record), scaled by area to the
// outlet, is compared on Calibration with the shown run's simulated and
// natural flow. Stored in project.settings.referenceGauge. Like
// settings.ewrHeadline it is **no model input**: a run never reads the
// reference record (docs/model.md, importing a reference gauge), so runs
// don't record it (runs/execute.ts), saving it alone leaves updated_at alone
// (projects/routes.ts), and every run is compared by the project's current
// areas.
//
//   areaKm2        the reference gauge's own catchment area
//   targetAreaKm2  the area at the outlet it is compared at; null = the
//                  model's catchment area (the shown run's)
//   name           what to call it (optional, '' = "the reference gauge")
import { z } from 'zod';

export interface ReferenceGauge {
	areaKm2: number;
	targetAreaKm2: number | null;
	name: string;
}

/** The largest area either field takes (km²): past any South African river's. */
export const REFERENCE_AREA_MAX_KM2 = 1_000_000;

const area = z.number().finite().positive().max(REFERENCE_AREA_MAX_KM2);

/** The settings patch's shape for `referenceGauge` (projects/settings.ts): replaced whole, null = none. */
export const ReferenceGaugePatch = z
	.object({
		areaKm2: area,
		targetAreaKm2: area.nullable(),
		name: z.string().trim().max(80)
	})
	.strict()
	.nullable();

/** settings.referenceGauge, or null when absent or not valid. */
export function resolveReferenceGauge(settings: unknown): ReferenceGauge | null {
	const raw = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>).referenceGauge : undefined;
	const p = ReferenceGaugePatch.safeParse(raw);
	return p.success ? p.data : null;
}
