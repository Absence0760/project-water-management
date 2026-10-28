// The places a run's warnings name (places.ts, issue #586 D19): found in the text, as now and as older runs named
// them, and every place a warning in the engine names is one the app knows.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeName, placesIn, WARNING_PLACES, warningInCurrentWords, type WarningPlace } from './places';
import { toEpochDay } from './calendar';
import { checkSeries } from './quality';
import { abstractionStartDay } from './network/development';
import { resolveReportWindow } from './run';

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

	it('finds a panel by its former heading, as runs before its rename named it (issue #614, engine 1.103.0)', () => {
		expect(placeName('share')).toBe('Model settings → Model selection for flow generation');
		// 1.98.0 to 1.102.0, and before 1.98.0.
		expect(named('the other method (Model settings → Flow generation: Fragmentation)')).toEqual([['Model settings → Flow generation', 'share']]);
		expect(named('or the high/low MAP split (Settings → Flow generation) so')).toEqual([['Settings → Flow generation', 'share']]);
		expect(named('see Model settings → Model selection for flow generation.')).toEqual([['Model settings → Model selection for flow generation', 'share']]);
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

describe('warningInCurrentWords', () => {
	it('reads a warning from before engine 1.98.0 in today’s words', () => {
		expect(warningInCurrentWords('pick a gauge, or the outlet, in Settings → Calibration record')).toBe('pick a gauge, or the outlet, in Calibration → Calibration record');
		expect(warningInCurrentWords('history; the Plausibility checks panel has the table.')).toBe('history; Calibration → Plausibility checks has the table.');
		expect(warningInCurrentWords('rain stations: the setting is not an object, so it is ignored (docs/model.md §2.4i)')).toBe('rain stations: the setting is not an object, so it is ignored');
		expect(warningInCurrentWords('Validation signatures (provisional limits): on the 3 scored days')).toBe('Hydrological signatures (provisional limits): on the 3 scored days');
		expect(warningInCurrentWords('Set the monthly A-pan (Settings) or load a daily A-pan series')).toBe('Set the monthly A-pan (Model settings → Demand) or load a daily A-pan series');
		expect(warningInCurrentWords('An editor declares the rule under Settings › Evidence.')).toBe('An editor declares the rule under Model settings → Evidence.');
	});

	it('reads a warning from before engine 1.103.0 by the flow generation panel’s heading now (issue #614)', () => {
		const now = 'Model settings → Model selection for flow generation';
		expect(warningInCurrentWords('the other flow generation method (Model settings → Flow generation: Fragmentation, one GR4J run)')).toBe(`the other flow generation method (${now}: Fragmentation, one GR4J run)`);
		expect(warningInCurrentWords('Correct the high/low MAP split (Settings → Flow generation) so they add up to 100%')).toBe(`Correct the high/low MAP split (${now}) so they add up to 100%`);
		expect(warningInCurrentWords('Correct the high/low MAP split (Settings) so')).toBe(`Correct the high/low MAP split (${now}) so`);
	});

	it('reads a data check from before engine 1.99.0, its dates year first, in today’s words (issue #586)', () => {
		// Today's words, from the check itself; the same text with its dates year first is how 1.98.0 wrote it.
		const v = [1, 2, 3, 4, -0.4, 2, ...new Array(6).fill(5.35), 3, 2, 1];
		const checks = checkSeries('rain_chirps_mm', { startDate: '2020-10-02', values: v });
		expect(checks.length).toBeGreaterThan(1);
		const iso: Record<string, string> = { '6 Oct 2020': '2020-10-06', '8 Oct 2020': '2020-10-08' };
		for (const c of checks) {
			const old = c.text.replace(/\d{1,2} [A-Z][a-z]{2} \d{4}/g, (d) => iso[d]!);
			expect(old).toMatch(/\(2020-10-0\d: /);
			expect(warningInCurrentWords(old)).toBe(c.text);
		}
		const zero = 'Rainfall (catchment): 1 run of zero rain covering 60+ days of the wet season (Jun, Jul): 2012-06-01 to 2012-08-15 (76 days, 76 in the wet season, which usually brings about 120 mm). Real dry spells?';
		expect(warningInCurrentWords(zero)).toBe(
			'Rainfall (catchment): 1 run of zero rain covering 60+ days of the wet season (Jun, Jul): 1 Jun 2012 to 15 Aug 2012 (76 days, 76 in the wet season, which usually brings about 120 mm). Real dry spells?'
		);
	});

	it('reads any warning from before engine 1.100.0, its dates year first, in today’s words (issue #586 R4-O)', () => {
		// Today's words, from the engine itself; the same text with its days year first is how 1.99.0 wrote it.
		const today: string[] = [];
		abstractionStartDay({ id: 'g', kind: 'gauge', name: 'Weir', abstractionFrom: '2021-01-01' } as never, 0, 10, today);
		resolveReportWindow({ reportStart: '2019-12-01', reportEnd: '2020-02-29' }, toEpochDay('2020-01-01'), 31, today);
		resolveReportWindow({ reportStart: '2020-03-01', reportEnd: '2020-02-01' }, toEpochDay('2020-01-01'), 31, today);
		expect(today).toEqual([
			'gauge "Weir": abstraction start 1 Jan 2021 ignored (a gauge takes no water)',
			'reporting window 1 Dec 2019 … 29 Feb 2020 is clipped to the run (1 Jan 2020 … 31 Jan 2020)',
			'reporting window 1 Mar 2020 … 1 Feb 2020 does not overlap the run (1 Jan 2020 … 31 Jan 2020); the curtailment report covers the whole run'
		]);
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const iso = (d: string) => {
			const [day, mon, year] = d.split(' ');
			return `${year}-${String(months.indexOf(mon!) + 1).padStart(2, '0')}-${day!.padStart(2, '0')}`;
		};
		for (const w of today) {
			const old = w.replace(/\d{1,2} [A-Z][a-z]{2} \d{4}/g, iso);
			expect(old).toMatch(/\b20\d\d-\d\d-\d\d\b/);
			expect(warningInCurrentWords(old)).toBe(w);
		}
		// 1.99.0 quoted the abstraction start's day; 1.100.0 doesn't, and a value that isn't a day stays quoted.
		expect(warningInCurrentWords('gauge "Weir": abstraction start "2021-01-01" ignored (a gauge takes no water)')).toBe(today[0]);
		expect(warningInCurrentWords('farm "A": abstraction start "2021-02-30" ignored (not a date, YYYY-MM-DD)')).toBe('farm "A": abstraction start "2021-02-30" ignored (not a date, YYYY-MM-DD)');
		expect(warningInCurrentWords('Catchment rain accumulations spread over the days they cover: 1 window, 3 run days: 2024-01-01 to 2024-01-03 (3 days, 40 mm read on 2024-01-03, detected).')).toBe(
			'Catchment rain accumulations spread over the days they cover: 1 window, 3 run days: 1 Jan 2024 to 3 Jan 2024 (3 days, 40 mm read on 3 Jan 2024, detected).'
		);
	});

	it('leaves what isn’t a calendar day as it is', () => {
		// 2001 is no leap year, and there is no month 13: the text is as the engine wrote it (an input it refused, say).
		for (const w of ['rain-source period 2001-02-29 to 2001-13-01 needs a reason; ignored', 'reportStart "2020-1-5" is not a date (YYYY-MM-DD)', 'water years 2015/16–2017/18'])
			expect(warningInCurrentWords(w)).toBe(w);
	});

	it('leaves a warning in today’s words as it is', () => {
		for (const w of ['Kept as Model settings → Rain gaps → Flagged rain says.', 'No place here.', `See ${placeName('fit', 'Calibration rules')}.`]) expect(warningInCurrentWords(w)).toBe(w);
	});
});
