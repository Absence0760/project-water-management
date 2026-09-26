import { describe, expect, it } from 'vitest';
import {
	ARC4_URL,
	calendarToWaterYear,
	citation,
	CROP_LIBRARY,
	LIBRARY_SYSTEMS,
	libraryCropFactor,
	SABI_NORMS_URL,
	stagedToWaterYear,
	type LibraryCrop
} from './library';

// Each row as printed in the ARC/SABI Irrigation Design Manual ch. 4 (Jan …
// Dec, "-" for a blank cell), transcribed from the PDF text independently of
// library.ts so a typo in either fails here. Checked against the rendered
// pages 4.47, 4.50 and 4.51.
const PRINTED: Record<string, [table: string, page: string, row: string]> = {
	citrus: ['4.13', '4.50', '0.40 0.40 0.50 0.50 0.40 0.40 0.30 0.30 0.40 0.40 0.40 0.40'],
	'table-grapes': ['4.13', '4.50', '0.50 0.60 0.60 0.30 0.20 0.20 0.20 0.20 0.20 0.30 0.40 0.50'],
	'deciduous-late': ['4.13', '4.50', '0.55 0.55 0.55 0.35 0.20 0.20 0.20 0.25 0.30 0.40 0.45 0.50'],
	'deciduous-medium': ['4.13', '4.50', '0.55 0.40 0.35 0.30 0.20 0.20 0.20 0.25 0.30 0.40 0.45 0.50'],
	'deciduous-early': ['4.13', '4.50', '0.40 0.35 0.35 0.30 0.20 0.20 0.20 0.25 0.30 0.40 0.45 0.50'],
	'wine-sub': ['4.13', '4.50', '0.25 0.25 0.20 0.20 0.20 0.20 0.20 0.20 0.20 0.20 0.25 0.25'],
	'wine-late': ['4.13', '4.50', '0.50 0.50 0.50 0.30 0.20 0.20 0.20 0.20 0.20 0.30 0.40 0.50'],
	'wine-early': ['4.13', '4.50', '0.50 0.50 0.30 0.20 0.20 0.20 0.20 0.20 0.20 0.30 0.40 0.50'],
	'pasture-mixed': ['4.13', '4.50', '0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55'],
	'pasture-kikuyu': ['4.13', '4.50', '0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55'],
	alfalfa: ['4.13', '4.50', '0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55 0.55'],
	guavas: ['4.13', '4.50', '0.40 0.50 0.40 0.40 0.30 0.30 0.30 0.20 0.20 0.20 0.30 0.40'],
	pecan: ['4.10', '4.47', '0.65 0.65 0.65 0.65 0.35 0.35 0.35 0.65 0.65 0.65 0.65 0.65'],
	mealies: ['4.14', '4.51', '0.55 0.40 - - - - - - - 0.30 0.50 0.55'],
	wheat: ['4.14', '4.51', '- - - - 0.25 0.30 0.50 0.65 0.40 - - -'],
	soya: ['4.14', '4.51', '0.60 0.70 0.55 0.55 - - - - - - - 0.30'],
	'potatoes-jan': ['4.14', '4.51', '0.40 0.70 0.60 - - - - - - - - -'],
	'potatoes-jun': ['4.14', '4.51', '- - - - - 0.40 0.70 0.70 0.55 - - -'],
	'potatoes-aug': ['4.14', '4.51', '- - - - - - - 0.40 0.70 0.70 0.55 -'],
	'potatoes-nov': ['4.14', '4.51', '0.60 - - - - - - - - - 0.40 0.70']
};
// Table 4.15 (p. 4.51): 0–20, 20–40, 40–60, 60–80, 80–100 % of the growing season.
const STAGED: Record<string, string> = {
	beans: '0.25 0.30 0.50 0.50 0.55',
	brassicas: '0.30 0.50 0.50 0.55 0.55',
	cucurbits: '0.25 0.30 0.40 0.40 0.40',
	peas: '0.25 0.30 0.30 0.55 0.50',
	onions: '0.25 0.30 0.50 0.50 0.50',
	tomatoes: '0.25 0.30 0.50 0.55 0.55'
};
// Table 4.7's "Days" for the planting options offered (pp. 4.25–4.28).
const SEASONS: Record<string, string> = {
	beans: 'Dry, spring 100; Green, spring/summer 90',
	brassicas: 'Broccoli 80; Brussels sprouts, autumn 120; Cabbage, early, spring 75; Cauliflower, main, autumn 120',
	cucurbits: 'Spring/summer 130; Autumn/winter 140',
	peas: 'Autumn/winter 110',
	onions: 'Autumn transplant 160',
	tomatoes: 'Table 160; Processing 100'
};
const parse = (row: string) => row.split(' ').map((v) => (v === '-' ? null : Number(v)));

describe('the reference crop library', () => {
	it('has every printed row, and nothing else', () => {
		expect(CROP_LIBRARY.map((c) => c.id).sort()).toEqual([...Object.keys(PRINTED), ...Object.keys(STAGED)].sort());
		expect(new Set(CROP_LIBRARY.map((c) => c.id)).size).toBe(CROP_LIBRARY.length);
	});

	it.each(Object.entries(PRINTED))('%s matches its table exactly', (id, [table, page, row]) => {
		const c = CROP_LIBRARY.find((x) => x.id === id)!;
		expect(c.kind).toBe('monthly');
		if (c.kind !== 'monthly') return;
		expect(c.calendar).toEqual(parse(row));
		expect([c.table, c.page]).toEqual([table, page]);
	});

	it.each(Object.entries(STAGED))('%s matches Table 4.15 and Table 4.7 exactly', (id, row) => {
		const c = CROP_LIBRARY.find((x) => x.id === id)!;
		expect(c.kind).toBe('staged');
		if (c.kind !== 'staged') return;
		expect(c.stages).toEqual(parse(row));
		expect([c.table, c.page]).toEqual(['4.15', '4.51']);
		expect(c.seasons.map((s) => `${s.label} ${s.days}`).join('; ')).toBe(SEASONS[id]);
		for (const s of c.seasons) expect(['4.25', '4.26', '4.27', '4.28']).toContain(s.page);
	});

	it('has a sane shape and a citation for every crop', () => {
		const systems = new Set(LIBRARY_SYSTEMS.map((s) => s.id));
		for (const c of CROP_LIBRARY) {
			const values = c.kind === 'monthly' ? c.calendar : c.stages;
			expect(values, c.id).toHaveLength(c.kind === 'monthly' ? 12 : 5);
			for (const f of values) if (f !== null) expect(f >= 0 && f <= 1.5, `${c.id} ${f}`).toBe(true);
			expect(c.name.length, c.id).toBeGreaterThan(2);
			expect(citation(c)).toMatch(/^ARC\/SABI Irrigation Design Manual, ch\. 4, Table 4\.1[0345], p\. 4\.[45]\d$/);
			expect(systems.has(c.system), c.id).toBe(true);
			const f = libraryCropFactor(c, { month: 5, day: 1, days: 160 })!;
			expect(f, c.id).toHaveLength(12);
		}
		expect(ARC4_URL).toMatch(/^https:\/\/sabi\.co\.za\/.+Chapter-4-Crop-water-requirements\.pdf$/);
		expect(SABI_NORMS_URL).toMatch(/^https:\/\/sabi\.co\.za\/.+SABI-Norms-Agricultural-2021\.pdf$/);
	});

	it('gives pecan its own curve, not the deciduous one', () => {
		const pecan = libraryCropFactor(CROP_LIBRARY.find((c) => c.id === 'pecan')!)!;
		for (const id of ['deciduous-late', 'deciduous-medium', 'deciduous-early'])
			expect(libraryCropFactor(CROP_LIBRARY.find((c) => c.id === id)!)).not.toEqual(pecan);
	});
});

describe('SABI 2021 irrigation system efficiencies', () => {
	// Table 4, "proposed default system efficiency" min–max (%), pp. 9–10.
	const TABLE_4: Record<string, [number, number]> = {
		drip: [90, 95],
		micro: [80, 85],
		pivot: [80, 90],
		sprinkler: [75, 90],
		movable: [70, 83],
		surface: [60, 95] // piped 80–95, lined canal 70–90, earth canal 60–83
	};
	// Issue #54 Q10's recommended values.
	const Q10: Record<string, number> = { drip: 0.9, micro: 0.82, pivot: 0.85, sprinkler: 0.8, movable: 0.75, surface: 0.7 };

	it('keeps Table 4 ranges and offers the Q10 value, inside its range', () => {
		expect(LIBRARY_SYSTEMS.map((s) => s.id)).toEqual(Object.keys(TABLE_4));
		for (const s of LIBRARY_SYSTEMS) {
			expect([s.min * 100, s.max * 100].map(Math.round), s.id).toEqual(TABLE_4[s.id]);
			expect(s.efficiency, s.id).toBe(Q10[s.id]);
			expect(s.efficiency >= s.min && s.efficiency <= s.max, s.id).toBe(true);
		}
	});
});

describe('calendarToWaterYear', () => {
	it('reorders Jan … Dec to Oct … Sep, blanks as 0', () => {
		expect(calendarToWaterYear([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toEqual([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(calendarToWaterYear([null, 2, null, null, null, null, null, null, null, 10, null, null])).toEqual([10, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
	});

	it('gives citrus as the water year expects: Oct–Dec 0.40, Mar–Apr peak 0.50, Jul–Aug low 0.30', () => {
		expect(libraryCropFactor(CROP_LIBRARY.find((c) => c.id === 'citrus')!)).toEqual([0.4, 0.4, 0.4, 0.4, 0.4, 0.5, 0.5, 0.4, 0.4, 0.3, 0.3, 0.4]);
	});
});

describe('stagedToWaterYear (Table 4.15 stages → months)', () => {
	const onions = [0.25, 0.3, 0.5, 0.5, 0.5];

	it('recomputes onions planted 1 May, 160 days, by hand', () => {
		// Fifths of 32 days: 1 May–1 Jun 0.25, 2 Jun–3 Jul 0.30, 4 Jul–4 Aug 0.50, 5 Aug–5 Sep 0.50, 6 Sep–7 Oct 0.50.
		const cal = {
			May: 0.25,
			Jun: (0.25 + 29 * 0.3) / 30, // 0.2983
			Jul: (3 * 0.3 + 28 * 0.5) / 31, // 0.4806
			Aug: 0.5,
			Sep: 0.5,
			Oct: (7 * 0.5) / 31 // 0.1129
		};
		const r3 = (x: number) => Math.round(x * 1000) / 1000;
		// Oct, Nov, Dec, Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep
		expect(stagedToWaterYear(onions, 5, 1, 160)).toEqual([r3(cal.Oct), 0, 0, 0, 0, 0, 0, cal.May, r3(cal.Jun), r3(cal.Jul), cal.Aug, cal.Sep]);
	});

	it('wraps a season past December, and keeps the season total', () => {
		const f = stagedToWaterYear([1, 1, 1, 1, 1], 12, 1, 62); // 1 Dec – 31 Jan
		expect(f).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
		const days = [31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30];
		const f2 = stagedToWaterYear(onions, 3, 15, 150);
		const total = f2.reduce((s, v, m) => s + v * days[m]!, 0);
		const exact = 30 * (0.25 + 0.3 + 0.5 + 0.5 + 0.5);
		// Only the 3-decimal rounding: at most 0.0005 × days in each month the season touches.
		const bound = f2.reduce((s, v, m) => s + (v > 0 ? 0.0005 * days[m]! : 0), 0);
		expect(Math.abs(total - exact)).toBeLessThanOrEqual(bound);
	});

	it('refuses a planting it cannot place, and a staged crop needs one', () => {
		expect(() => stagedToWaterYear(onions, 13, 1, 100)).toThrow(RangeError);
		expect(() => stagedToWaterYear(onions, 5, 1, 0)).toThrow(RangeError);
		expect(() => stagedToWaterYear(onions, 5, 1, 400)).toThrow(RangeError);
		const staged = CROP_LIBRARY.find((c) => c.id === 'onions') as LibraryCrop;
		expect(libraryCropFactor(staged)).toBeNull();
		expect(libraryCropFactor(staged, { month: 5, day: 1, days: 0 })).toBeNull();
		expect(stagedToWaterYear(onions, 2, 29, 10)).toEqual(stagedToWaterYear(onions, 2, 28, 10));
	});
});
