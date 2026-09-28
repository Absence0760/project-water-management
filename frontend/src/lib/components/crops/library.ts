// Reference crop library (issue #54 item 1): published A-pan crop factors
// for the winter-rainfall area, for the Crops tab's "Load crop factors"
// dialog. Reference data only: nothing here changes a project until a
// modeller loads it, reviews the diff and saves (docs/model.md §2.3,
// docs/ui.md § Load crop factors). Which crop set a catchment uses is the hydrologist's
// call (issue #54 Q9/Q10, docs/engine-audit.md).
//
// Every factor is copied exactly from the source table as printed (Jan–Dec)
// and pinned by library.test.ts. Nothing is estimated. Two things are
// derived, both reproducibly:
//   - the water-year order the model uses (Oct … Sep): calendarToWaterYear;
//   - a monthly curve for a vegetable, whose table gives a factor per fifth
//     of the growing season: stagedToWaterYear, from a planting date and a
//     season length the modeller gives (the manual's Table 4.7 lists season
//     lengths for some planting options; they're offered, not assumed).
//
// Sources:
//   [ARC4] ARC/SABI Irrigation Design Manual, chapter 4 "Crop water
//          requirements": Tables 4.10, 4.13–4.15 (A-pan design crop factors,
//          f = kp × kc, eq. 4.7) and Table 4.7 (season lengths).
//   [SABI] SABI Agricultural Design Norms 2021, Table 4 "System efficiency"
//          (adapted from Reinders et al. 2010).

export const ARC4_URL = 'https://sabi.co.za/wp-content/uploads/2025/04/Chapter-4-Crop-water-requirements.pdf';
export const SABI_NORMS_URL = 'https://sabi.co.za/wp-content/uploads/2023/02/SABI-Norms-Agricultural-2021.pdf';
export const ARC4 = 'ARC/SABI Irrigation Design Manual, ch. 4';

/** An irrigation system with its SABI 2021 efficiency range and the value the dialog offers. */
export interface LibrarySystem {
	id: string;
	label: string;
	/** Table 4's minimum and maximum "proposed default system efficiency" (net to gross), as fractions. */
	min: number;
	max: number;
	/**
	 * What the dialog offers: issue #54 Q10's recommended mid-range value,
	 * inside [min, max] but not always the midpoint (drip is its minimum).
	 */
	efficiency: number;
}

/** [SABI] Table 4, pp. 9–10. Surface spans its three rows (piped 80–95, lined canal 70–90, earth canal 60–83). */
export const LIBRARY_SYSTEMS: readonly LibrarySystem[] = [
	{ id: 'drip', label: 'Drip', min: 0.9, max: 0.95, efficiency: 0.9 },
	{ id: 'micro', label: 'Micro-sprinkler', min: 0.8, max: 0.85, efficiency: 0.82 },
	{ id: 'pivot', label: 'Centre pivot / linear move', min: 0.8, max: 0.9, efficiency: 0.85 },
	{ id: 'sprinkler', label: 'Sprinkler (permanent)', min: 0.75, max: 0.9, efficiency: 0.8 },
	{ id: 'movable', label: 'Sprinkler (movable)', min: 0.7, max: 0.83, efficiency: 0.75 },
	{ id: 'surface', label: 'Surface', min: 0.6, max: 0.95, efficiency: 0.7 }
];

interface Base {
	id: string;
	name: string;
	/** Source table number in [ARC4], and its page as printed. */
	table: string;
	page: string;
	notes: string;
	/**
	 * A typical system for the crop (a LIBRARY_SYSTEMS id). Not from the
	 * manual: which systems the farms use is issue #54 Q10, so the dialog
	 * shows it as a hint and never applies it unasked.
	 */
	system: string;
}

/** A crop whose table gives a factor per calendar month. */
export interface MonthlyLibraryCrop extends Base {
	kind: 'monthly';
	/** Jan … Dec exactly as printed; null = a blank cell (the crop isn't in the ground). */
	calendar: readonly (number | null)[];
}

/** A vegetable whose table gives a factor per fifth of the growing season (0–20 % … 80–100 %). */
export interface StagedLibraryCrop extends Base {
	kind: 'staged';
	stages: readonly number[];
	/** Season lengths [ARC4] Table 4.7 gives for this crop (its "Days" column), with the planting option and page. */
	seasons: readonly { label: string; days: number; page: string }[];
}

export type LibraryCrop = MonthlyLibraryCrop | StagedLibraryCrop;

const _ = null;
const perennial = (id: string, name: string, calendar: (number | null)[], system: string, notes = ''): MonthlyLibraryCrop => ({
	kind: 'monthly',
	id,
	name,
	table: '4.13',
	page: '4.50',
	calendar,
	system,
	notes
});
const agronomic = (id: string, name: string, calendar: (number | null)[], notes: string): MonthlyLibraryCrop => ({
	kind: 'monthly',
	id,
	name,
	table: '4.14',
	page: '4.51',
	calendar,
	system: 'pivot',
	notes: `${notes} Blank months are 0 (not in the ground). A part month at planting or harvest carries the month's printed factor, not prorated.`
});
const vegetable = (id: string, name: string, stages: number[], seasons: StagedLibraryCrop['seasons'], notes = ''): StagedLibraryCrop => ({
	kind: 'staged',
	id,
	name,
	table: '4.15',
	page: '4.51',
	stages,
	seasons,
	system: 'sprinkler',
	notes: `Staged by portion of the growing season; set the planting date and season length.${notes ? ` ${notes}` : ''}`
});
const ORCHARD = 'Clean-cultivated: a cover crop raises the factor (issue #54 caveats).';

/** The library, in the tables' order. */
export const CROP_LIBRARY: readonly LibraryCrop[] = [
	// [ARC4] Table 4.13, perennial crops, winter rainfall area (June 1990), p. 4.50.
	perennial('citrus', 'Citrus', [0.4, 0.4, 0.5, 0.5, 0.4, 0.4, 0.3, 0.3, 0.4, 0.4, 0.4, 0.4], 'micro', `Evergreen. ${ORCHARD}`),
	perennial('table-grapes', 'Table grapes', [0.5, 0.6, 0.6, 0.3, 0.2, 0.2, 0.2, 0.2, 0.2, 0.3, 0.4, 0.5], 'drip'),
	perennial('deciduous-late', 'Deciduous fruit, late cultivars', [0.55, 0.55, 0.55, 0.35, 0.2, 0.2, 0.2, 0.25, 0.3, 0.4, 0.45, 0.5], 'micro', ORCHARD),
	perennial('deciduous-medium', 'Deciduous fruit, medium cultivars', [0.55, 0.4, 0.35, 0.3, 0.2, 0.2, 0.2, 0.25, 0.3, 0.4, 0.45, 0.5], 'micro', ORCHARD),
	perennial('deciduous-early', 'Deciduous fruit, early cultivars', [0.4, 0.35, 0.35, 0.3, 0.2, 0.2, 0.2, 0.25, 0.3, 0.4, 0.45, 0.5], 'micro', `E.g. early stone fruit. ${ORCHARD}`),
	perennial('wine-sub', 'Wine grapes, sub-intensive', [0.25, 0.25, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.25, 0.25], 'drip'),
	perennial('wine-late', 'Wine grapes, intensive, late', [0.5, 0.5, 0.5, 0.3, 0.2, 0.2, 0.2, 0.2, 0.2, 0.3, 0.4, 0.5], 'drip'),
	perennial('wine-early', 'Wine grapes, intensive, early', [0.5, 0.5, 0.3, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.3, 0.4, 0.5], 'drip'),
	perennial('pasture-mixed', 'Pasture, mixed', new Array(12).fill(0.55), 'pivot'),
	perennial('pasture-kikuyu', 'Pasture, kikuyu', new Array(12).fill(0.55), 'pivot'),
	perennial('alfalfa', 'Alfalfa (lucerne), frost areas', new Array(12).fill(0.55), 'pivot'),
	perennial('guavas', 'Guavas (pruned Aug)', [0.4, 0.5, 0.4, 0.4, 0.3, 0.3, 0.3, 0.2, 0.2, 0.2, 0.3, 0.4], 'micro'),
	// [ARC4] Table 4.10, perennial crops, summer rainfall areas (June 1996), p. 4.47: the winter-rainfall table has no pecan.
	{
		kind: 'monthly',
		id: 'pecan',
		name: 'Pecan nuts',
		table: '4.10',
		page: '4.47',
		calendar: [0.65, 0.65, 0.65, 0.65, 0.35, 0.35, 0.35, 0.65, 0.65, 0.65, 0.65, 0.65],
		system: 'micro',
		notes: 'From the summer-rainfall table: the winter-rainfall table has no pecan. Its own curve, not the apple curve.'
	},
	// [ARC4] Table 4.14, agronomic crops, winter rainfall area (June 1990), p. 4.51.
	agronomic('mealies', 'Mealies (maize), plant 1 Oct', [0.55, 0.4, _, _, _, _, _, _, _, 0.3, 0.5, 0.55], 'Planted 1 Oct, season ends 15 Feb.'),
	agronomic('wheat', 'Wheat, plant 15 May', [_, _, _, _, 0.25, 0.3, 0.5, 0.65, 0.4, _, _, _], 'Planted 15 May, season ends 15 Sept.'),
	agronomic('soya', 'Soya beans, plant 1 Dec', [0.6, 0.7, 0.55, 0.55, _, _, _, _, _, _, _, 0.3], 'Planted 1 Dec, season ends 15 Apr.'),
	agronomic('potatoes-jan', 'Potatoes, plant 1 Jan', [0.4, 0.7, 0.6, _, _, _, _, _, _, _, _, _], 'Planted 1 Jan, season ends 31 Mar.'),
	agronomic('potatoes-jun', 'Potatoes, plant 1 Jun', [_, _, _, _, _, 0.4, 0.7, 0.7, 0.55, _, _, _], 'Planted 1 Jun, season ends 30 Sep (printed "31 Sept").'),
	agronomic('potatoes-aug', 'Potatoes, plant 1 Aug', [_, _, _, _, _, _, _, 0.4, 0.7, 0.7, 0.55, _], 'Planted 1 Aug, season ends 30 Nov.'),
	agronomic('potatoes-nov', 'Potatoes, plant 1 Nov', [0.6, _, _, _, _, _, _, _, _, _, 0.4, 0.7], 'Planted 1 Nov, season ends 31 Jan.'),
	// [ARC4] Table 4.15, vegetables, winter rainfall area (June 1990), p. 4.51; season lengths from Table 4.7, pp. 4.25–4.28.
	vegetable('beans', 'Beans', [0.25, 0.3, 0.5, 0.5, 0.55], [
		{ label: 'Dry, spring', days: 100, page: '4.25' },
		{ label: 'Green, spring/summer', days: 90, page: '4.25' }
	]),
	vegetable('brassicas', 'Brassicas', [0.3, 0.5, 0.5, 0.55, 0.55], [
		{ label: 'Broccoli', days: 80, page: '4.25' },
		{ label: 'Brussels sprouts, autumn', days: 120, page: '4.25' },
		{ label: 'Cabbage, early, spring', days: 75, page: '4.25' },
		{ label: 'Cauliflower, main, autumn', days: 120, page: '4.25' }
	]),
	vegetable('cucurbits', 'Cucurbits', [0.25, 0.3, 0.4, 0.4, 0.4], [
		{ label: 'Spring/summer', days: 130, page: '4.26' },
		{ label: 'Autumn/winter', days: 140, page: '4.26' }
	]),
	vegetable('peas', 'Peas', [0.25, 0.3, 0.3, 0.55, 0.5], [{ label: 'Autumn/winter', days: 110, page: '4.27' }]),
	vegetable('onions', 'Onions', [0.25, 0.3, 0.5, 0.5, 0.5], [{ label: 'Autumn transplant', days: 160, page: '4.26' }], 'The table has no bulb dry-down drop before harvest.'),
	vegetable('tomatoes', 'Tomatoes', [0.25, 0.3, 0.5, 0.55, 0.55], [
		{ label: 'Table', days: 160, page: '4.28' },
		{ label: 'Processing', days: 100, page: '4.28' }
	])
];

/** Jan … Dec (blank = 0) → the model's water-year order, Oct … Sep. */
export function calendarToWaterYear(calendar: readonly (number | null)[]): number[] {
	return Array.from({ length: 12 }, (_v, m) => calendar[(m + 9) % 12] ?? 0);
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * A staged crop's monthly factors (water-year order) for a season of
 * `seasonDays` days (1–365) planted on `day` of calendar `month` (1–12):
 * day k of the season (0-based) takes the stage factor of its fifth,
 * stages[floor(5k ÷ seasonDays)]; a month's factor is the sum over its days
 * ÷ its days, with days outside the season 0, so area × factor × A-pan
 * gives the month's requirement. A 365-day year (a 29 Feb planting counts
 * as 28 Feb); the season wraps past December. Rounded to 3 decimals.
 */
export function stagedToWaterYear(stages: readonly number[], month: number, day: number, seasonDays: number): number[] {
	if (!(Number.isInteger(month) && month >= 1 && month <= 12)) throw new RangeError('month must be 1–12');
	if (!(Number.isInteger(seasonDays) && seasonDays >= 1 && seasonDays <= 365)) throw new RangeError('season must be 1–365 days');
	const d = Math.min(Math.max(1, Math.trunc(day)), DAYS[month - 1]!);
	let doy = d - 1;
	for (let m = 0; m < month - 1; m++) doy += DAYS[m]!;
	const monthOf: number[] = [];
	DAYS.forEach((n, m) => {
		for (let i = 0; i < n; i++) monthOf.push(m);
	});
	const sum = new Array<number>(12).fill(0);
	for (let k = 0; k < seasonDays; k++) sum[monthOf[(doy + k) % 365]!]! += stages[Math.floor((5 * k) / seasonDays)]!;
	return calendarToWaterYear(sum.map((s, m) => Math.round((s / DAYS[m]!) * 1000) / 1000));
}

/** A planting for a staged crop: calendar month 1–12, day of month, season length in days. */
export interface Planting {
	month: number;
	day: number;
	days: number;
}

/** A library crop's factors in water-year order, or null for a staged crop without a valid planting. */
export function libraryCropFactor(crop: LibraryCrop, planting?: Planting | null): number[] | null {
	if (crop.kind === 'monthly') return calendarToWaterYear(crop.calendar);
	if (!planting) return null;
	try {
		return stagedToWaterYear(crop.stages, planting.month, planting.day, planting.days);
	} catch {
		return null;
	}
}

/** "ARC/SABI Irrigation Design Manual, ch. 4, Table 4.13, p. 4.50". */
export const citation = (c: LibraryCrop) => `${ARC4}, Table ${c.table}, p. ${c.page}`;
