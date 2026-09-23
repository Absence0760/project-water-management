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
