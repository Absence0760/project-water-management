// Generic rendering helpers for ProjectSettings.calibration, whose field set
// grows as the engine port proceeds: numbers become number inputs, number
// arrays become comma lists, anything else is shown read-only.

export type CalField =
	| { key: string; label: string; kind: 'number'; value: number }
	| { key: string; label: string; kind: 'list'; value: number[] }
	| { key: string; label: string; kind: 'boolean'; value: boolean }
	| { key: string; label: string; kind: 'other'; value: unknown };

const UNITS: Record<string, string> = { Mm: 'mm', M3: 'm³', M3s: 'm³/s', M3Day: 'm³/day', Pct: '%', Km2: 'km²' };

/** "rainThresholdMm" → "Rain threshold (mm)"; "a" → "a". */
export function humanise(key: string): string {
	if (key.length <= 2) return key;
	let unit = '';
	for (const [suffix, u] of Object.entries(UNITS).sort((a, b) => b[0].length - a[0].length)) {
		if (key.endsWith(suffix) && key.length > suffix.length) {
			unit = u;
			key = key.slice(0, -suffix.length);
			break;
		}
	}
	const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
	const text = words.charAt(0).toUpperCase() + words.slice(1);
	return unit ? `${text} (${unit})` : text;
}

export function calibrationFields(cal: Record<string, unknown>): CalField[] {
	return Object.entries(cal).map(([key, value]): CalField => {
		const label = humanise(key);
		if (typeof value === 'number') return { key, label, kind: 'number', value };
		if (Array.isArray(value) && value.every((v) => typeof v === 'number')) return { key, label, kind: 'list', value };
		if (typeof value === 'boolean') return { key, label, kind: 'boolean', value };
		return { key, label, kind: 'other', value };
	});
}

/** "10, 11,12" → [10, 11, 12]; returns null if any item isn't a number. Empty → []. */
export function parseNumberList(text: string): number[] | null {
	const parts = text.split(/[,;\s]+/).filter(Boolean);
	const nums = parts.map(Number);
	return nums.every(Number.isFinite) ? nums : null;
}

// ---------------------------------------------------------------------------
// Known calibration parameters (CalibrationParams in the engine), grouped the
// way a hydrologist tunes them, with units and help. Keys not listed here
// still render through calibrationFields() under "Other".

export interface CalParam {
	key: string;
	label: string;
	unit?: string;
	help: string;
	step?: number;
}

export const FLOW_PARAMS: CalParam[] = [
	{ key: 'a', label: 'Peak-flow coefficient a', help: 'In rain-driven flow = a · Rain^b. Scales how much flow a rain day produces.', step: 0.01 },
	{ key: 'b', label: 'Peak-flow exponent b', help: 'In a · Rain^b. Above 1, big storms produce disproportionately more flow.', step: 0.01 },
	{
		key: 'rainThresholdMm',
		label: 'Rain threshold',
		unit: 'mm',
		help: 'Rain at or below this produces no flow and does not reduce irrigation demand (it is lost to interception and wetting the soil).',
		step: 0.1
	},
	{ key: 'summerFactor', label: 'Summer factor', help: 'Rain-to-flow multiplier in summer (dry soils, high evaporation), usually well below the winter factor.', step: 0.01 },
	{ key: 'winterFactor', label: 'Winter factor', help: 'Rain-to-flow multiplier in winter, the wet season.', step: 0.01 },
	{ key: 'baseFlowInitial', label: 'Initial base flow', unit: 'm³/day', help: 'Base flow on the day before the simulation starts; it then recedes day by day without rain.' }
];

export const ADVANCED_PARAMS: CalParam[] = [
	{
		key: 'baseResetRatio',
		label: 'Base-flow reset ratio',
		help: 'When a rain pulse exceeds this multiple of the receding base flow, the base flow resets to the new, higher level.',
		step: 0.1
	},
	{ key: 'winterTodayRainMm', label: 'Winter switch, rain today', unit: 'mm', help: 'Outside the summer months: rain today at or above this switches to winter behaviour the same day.' },
	{ key: 'winterNextDayRainMm', label: 'Winter switch, rain yesterday', unit: 'mm', help: 'Outside the summer months: rain yesterday at or above this switches to winter behaviour today.' },
	{ key: 'shiftPeakIndexLo', label: 'Peak index, large events', help: 'Recession index a rain event as big as the amplitude below starts at (a low index recedes fast).', step: 0.1 },
	{ key: 'shiftPeakIndexHi', label: 'Peak index, small events', help: 'Recession index a vanishingly small rain event starts at.', step: 0.1 },
	{ key: 'amplitudeM3Day', label: 'Amplitude', unit: 'm³/day', help: 'Rain-driven flow that maps to the large-event peak index; smaller events start proportionally higher up the curve.' },
	{ key: 'recessionDaysMax', label: 'Longest recession', unit: 'days', help: 'Highest recession index used; flow keeps receding at the last factor beyond it.' }
];

export const TABLE_PARAMS: CalParam[] = [
	{ key: 'recessionFactors', label: 'Recession factors', help: 'Daily recession factor for each recession index (flow tomorrow ÷ flow today).' },
	{ key: 'recessionCurveM3Day', label: 'Recession curve', unit: 'm³/day', help: 'Smoothed recession flow for each index, descending; used to find where a flow sits on the curve.' }
];

/** Keys the Settings tab renders with dedicated controls. */
export const KNOWN_CAL_KEYS = new Set([
	...FLOW_PARAMS.map((p) => p.key),
	...ADVANCED_PARAMS.map((p) => p.key),
	...TABLE_PARAMS.map((p) => p.key),
	'summerMonths',
	'catchmentAreaKm2'
]);
