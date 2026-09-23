import { CALIBRATION_FLOW_KINDS, defaultProjectSettings, type ProjectSettings } from '@water-management/engine';
import { z } from 'zod';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Stored settings merged over the defaults (one level deep for nested
 * objects), so clients always see every field even after the engine adds new
 * ones. Unknown stored keys are kept.
 */
export function mergeSettings(stored: unknown): ProjectSettings {
	const base = defaultProjectSettings() as unknown as Json;
	const raw = isObj(stored) ? stored : {};
	const out: Json = { ...base, ...raw };
	for (const [k, v] of Object.entries(base)) {
		if (isObj(v) && isObj(raw[k])) out[k] = { ...v, ...(raw[k] as Json) };
	}
	return out as unknown as ProjectSettings;
}

const monthly = z.array(z.number().finite()).length(12);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Validates the known fields; extra keys (e.g. calibration parameters the
 * engine adds later) pass through but the whole object is size-capped.
 */
export const SettingsPatch = z
	.object({
		februaryDays: z.number().min(28).max(29),
		effectiveRainFraction: z.number().min(0).max(1),
		apanMm: monthly,
		flowShareMethod: z.enum(['area', 'hiLo', 'manual']),
		hiLoSplit: z.object({ hi: z.number().min(0).max(1), lo: z.number().min(0).max(1) }),
		calibration: z.record(z.string(), z.unknown()),
		ewrPragmaticM3PerDay: monthly,
		simulationStart: isoDate.nullable(),
		simulationEnd: isoDate.nullable(),
		calibrationStart: isoDate.nullable(),
		calibrationEnd: isoDate.nullable(),
		calibrationFlowKind: z.enum(CALIBRATION_FLOW_KINDS).nullable()
	})
	.partial()
	.passthrough()
	.refine((s) => JSON.stringify(s).length <= 64_000, 'settings too large');
