// The places a run's warnings name (places.ts, issue #586 D19): found in the text, as now and as older runs named
// them, and every place a warning in the engine names is one the app knows.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeName, placesIn, WARNING_PLACES, type WarningPlace } from './places';

const named = (text: string) => placesIn(text).map((m) => [text.slice(m.start, m.end), m.place]);

describe('placeName', () => {
	it('names the page, the panel’s heading and any steps inside it', () => {
		expect(placeName('rain', 'Flagged rain', 'Multi-day accumulations')).toBe('Model settings → Rain gaps → Flagged rain → Multi-day accumulations');
		expect(placeName('plausibility')).toBe('Calibration → Plausibility checks');
		expect(placeName('fit')).toBe('Calibration → Fit the parameters');
	});
});

describe('placesIn', () => {
	it('finds each place’s page and panel, in order, the steps after it left out', () => {
		expect(named('Kept as recorded, as Model settings → Rain gaps → Flagged rain says; refit under Calibration → Fit the parameters.')).toEqual([
			['Model settings → Rain gaps', 'rain'],
			['Calibration → Fit the parameters', 'fit']
		]);
		expect(named('(Calibration → Calibration record → Compare with)')).toEqual([['Calibration → Calibration record', 'record']]);
	});

	it('finds the names runs before engine 1.98.0 used, so their warnings link too', () => {
		expect(named('pick another site in Settings → Calibration record.')).toEqual([['Settings → Calibration record', 'record']]);
		expect(named('An editor declares the rule under Settings › Evidence, runs the model again.')).toEqual([['Settings › Evidence', 'evidence']]);
		expect(named('Check the base flow. The Plausibility checks panel lists the signatures.')).toEqual([['The Plausibility checks panel', 'plausibility']]);
		expect(named('history; the Plausibility checks panel has the table.')).toEqual([['the Plausibility checks panel', 'plausibility']]);
	});

	it('finds nothing in a sentence that names no place, nor a panel’s name without its page, nor a longer word', () => {
		expect(placesIn('The calibration record’s window is short.')).toEqual([]);
		expect(placesIn('Flow calibration is GR4J.')).toEqual([]);
		expect(placesIn('Model settings → Demands')).toEqual([]);
		expect(placesIn('')).toEqual([]);
	});

	it('finds every place by its name, once', () => {
		for (const key of Object.keys(WARNING_PLACES) as WarningPlace[]) {
			const text = `See ${placeName(key)}.`;
			expect(placesIn(text), key).toEqual([{ start: 4, end: 4 + placeName(key).length, place: key }]);
		}
	});
});

describe('the engine’s warnings', () => {
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((f) => {
			const p = join(dir, f);
			return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('generated') ? [p] : [];
		});
	const source = files(import.meta.dirname).map((p) => [p, readFileSync(p, 'utf8')] as const);

	it('name a place only as one the app knows: "Model settings → " or "Calibration → " then a panel’s heading', () => {
		const panels = Object.values(WARNING_PLACES).map((p) => `${p.page} → ${p.panel}`);
		for (const [path, text] of source) {
			for (const m of text.matchAll(/(Model settings|(?<![\p{L}])Calibration) → [^→.,;:()'"`]+/gu)) {
				const at = m[0].trimEnd();
				expect(
					panels.some((p) => at === p || at.startsWith(`${p} `)),
					`${path}: ${at}`
				).toBe(true);
			}
		}
	});

	it('no longer name Settings, the Plausibility checks panel or a repository document as a place (D19)', () => {
		for (const [path, text] of source.filter(([p]) => !p.endsWith('places.ts'))) {
			for (const line of text.split('\n')) {
				if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
				expect(/Settings (→|›) /.test(line), `${path}: ${line.trim()}`).toBe(false);
				expect(/Plausibility checks panel/.test(line), `${path}: ${line.trim()}`).toBe(false);
				expect(/\(docs\/model\.md §[^)]*\)['"`]/.test(line), `${path}: ${line.trim()}`).toBe(false);
			}
		}
	});
});
