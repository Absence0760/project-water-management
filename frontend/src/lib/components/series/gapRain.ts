// The gap-filling products beside CHIRPS (issue #604 R4-E, docs/ui.md § Data
// → Rain products side by side): what GET …/feeds/gap-rain returns
// (backend feeds/gapRainView.ts), the run-input series it stands for (as
// backend runs/gapRainInput.ts builds them, so the per-day preview fills a
// day as a run would), the chart's series, the double mass against each
// product (engine doubleMass with the product in CHIRPS' place, as a run's
// summary.gapRain.products[].doubleMass is made), and the credits their values
// carry. Pure: no Svelte, no DOM.
import {
	doubleMass,
	ERA5L_SERIES_KEY,
	fromEpochDay,
	IMERG_VERSION_RE,
	imergSeriesKey,
	rainCredits,
	toEpochDay,
	type DailySeries,
	type DataQualitySettings,
	type DoubleMass,
	type GapRainSettings,
	type GapRainSegment,
	type RainCredit,
	type ZeroRainSettings
} from '@water-management/engine';
import type { Api } from '#lib/api/client.js';
import type { ChartSeries } from '#lib/components/charts/series.js';

/** One CHIRPS feed the products can be read over: the outlet's, or a land unit's. */
export interface GapRainFeedOption {
	id: string;
	seriesId: string;
	seriesName: string;
	nodeId: string | null;
	nodeName: string | null;
	/** The feed whose cells the runs read the products over. */
	runsRead: boolean;
}

/** What the runs' CHIRPS feed's latest fetch made of a product (backend feeds/gapRainView.ts GapFillState). */
export interface GapFillState {
	status: 'ok' | 'not_ready' | 'failed';
	error: 'format' | 'unavailable' | 'refused' | null;
	at: string | null;
}

/** GET …/feeds/gap-rain (docs/api.md § Data feeds). */
export interface GapRainView {
	gapRain: GapRainSettings | null;
	feeds: GapRainFeedOption[];
	feed: string | null;
	/** The days read: by default the record's last ten years (the most one request reads). */
	window: { start: string; end: string } | null;
	/** The record's whole span. */
	record: { start: string; end: string } | null;
	fill: { era5l: GapFillState | null; imergLate: GapFillState | null };
	era5l: { startDate: string; values: (number | null)[]; held: number } | null;
	imergLate: { startDate: string; values: (number | null)[]; versions: (string | null)[]; held: number } | null;
}

export function gapRainApi(api: Pick<Api, 'request'>, projectId: string) {
	return {
		get: (feed?: string | null) => api.request<GapRainView>('GET', `/projects/${encodeURIComponent(projectId)}/feeds/gap-rain${feed ? `?feed=${encodeURIComponent(feed)}` : ''}`)
	};
}

/** Why a fill failed, in words (the backend sends only the code, never an error's text). */
const FILL_ERROR: Record<NonNullable<GapFillState['error']>, string> = {
	format: 'the rain data copy’s files aren’t in the form the app reads',
	unavailable: 'the rain data copy didn’t answer',
	refused: 'the cache refused the values the copy gave'
};

/**
 * The lines saying a product the settings read couldn't be filled on the
 * runs' feed's latest fetch ("Couldn’t fill ERA5-Land: …"), or that the copy
 * doesn't hold it yet; none for a product filled fine or not asked for.
 */
export function fillProblems(view: GapRainView | null): string[] {
	if (!view?.gapRain) return [];
	const out: string[] = [];
	const say = (name: string, s: GapFillState | null | undefined) => {
		if (s?.status === 'failed') out.push(`Couldn’t fill ${name} on the last fetch: ${s.error ? FILL_ERROR[s.error] : 'it failed'}. The next fetch tries again.`);
		else if (s?.status === 'not_ready') out.push(`The rain data copy holds no ${name} yet, so there is none to fill.`);
	};
	if (view.gapRain.product !== 'chirps') say('ERA5-Land', view.fill?.era5l);
	if (view.gapRain.imergLate) say('IMERG Late', view.fill?.imergLate);
	return out;
}

/** The products' names, as runs and exports name them. */
export const GAP_PRODUCT_LABEL = { chirps: 'CHIRPS', era5l: 'ERA5-Land', imerg_late: 'IMERG Late' } as const;

/** settings.gapRain in words, as runs and Settings → Rain gaps say it: "ERA5-Land, and IMERG Late for the recent days"; null is CHIRPS alone. */
export function gapRainChoiceText(g: GapRainSettings | null | undefined): string {
	const product = !g || g.product === 'chirps' ? 'CHIRPS' : g.product === 'era5l' ? 'ERA5-Land' : 'CHIRPS, then ERA5-Land where CHIRPS has none';
	return g?.imergLate ? `${product}, and IMERG Late for the recent days` : product;
}

/** A feed in the picker: the outlet's CHIRPS, or "<unit>: <series>". */
export const feedOptionLabel = (f: GapRainFeedOption): string => (f.nodeName ? `${f.nodeName}: ${f.seriesName}` : `Outlet: ${f.seriesName}`);

/**
 * The run-input series the view stands for: ERA5-Land under ERA5L_SERIES_KEY,
 * and one series per IMERG version (each day its own version), as the backend
 * hands a run them. Only the products `gap` reads; none without it.
 */
export function gapRainInputSeries(view: GapRainView | null, gap: GapRainSettings | null | undefined = view?.gapRain): Record<string, DailySeries> {
	const out: Record<string, DailySeries> = {};
	if (!view || !gap) return out;
	if (gap.product !== 'chirps' && view.era5l) out[ERA5L_SERIES_KEY] = { startDate: view.era5l.startDate, values: view.era5l.values };
	const im = view.imergLate;
	if (gap.imergLate && im) {
		const by = new Map<string, (number | null)[]>();
		im.values.forEach((v, i) => {
			const ver = im.versions[i];
			if (v === null || !ver || !IMERG_VERSION_RE.test(ver)) return;
			let vs = by.get(ver);
			if (!vs) by.set(ver, (vs = new Array<number | null>(im.values.length).fill(null)));
			vs[i] = v;
		});
		const d0 = toEpochDay(im.startDate);
		for (const [ver, values] of [...by].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			const first = values.findIndex((v) => v !== null);
			let last = values.length - 1;
			while (values[last] === null) last--;
			out[imergSeriesKey(ver)] = { startDate: fromEpochDay(d0 + first), values: values.slice(first, last + 1) };
		}
	}
	return out;
}

/** The IMERG version the copy holds for `date`, or null. */
export function imergVersionOn(view: GapRainView | null, date: string): string | null {
	const im = view?.imergLate;
	if (!im) return null;
	return im.versions[toEpochDay(date) - toEpochDay(im.startDate)] ?? null;
}

/** The IMERG version a run's segments give `date` (summary.gapRain.segments), or null. */
export function segmentVersionOn(segments: readonly GapRainSegment[] | null | undefined, date: string): string | null {
	for (const s of segments ?? []) if (s.product === 'imerg_late' && s.from <= date && date <= s.to) return s.version;
	return null;
}

/** The versions IMERG's days carry, in order. */
export const imergVersions = (view: GapRainView | null): string[] => [...new Set((view?.imergLate?.versions ?? []).filter((v): v is string => !!v))].sort();

/** The side-by-side chart's lines: CHIRPS, ERA5-Land, IMERG Late (each only when it has a day). */
export function productChartSeries(chirps: DailySeries | null, view: GapRainView | null): ChartSeries[] {
	const out: ChartSeries[] = [];
	if (chirps) out.push({ startDate: chirps.startDate, values: chirps.values, label: 'CHIRPS', color: '--series-1' });
	if (view?.era5l) out.push({ startDate: view.era5l.startDate, values: view.era5l.values, label: 'ERA5-Land', color: '--series-2' });
	if (view?.imergLate) {
		const v = imergVersions(view);
		out.push({ startDate: view.imergLate.startDate, values: view.imergLate.values, label: `IMERG Late${v.length ? ` (${v.join(', ')})` : ''}`, color: '--series-3', style: 'points' });
	}
	return out;
}

/** The chart's caption: what each line is, the span, and that the products show as read, before any correction. */
export function productChartCaption(view: GapRainView | null, feed: GapRainFeedOption | null): string {
	const where = feed ? `over the cells of ${feed.nodeName ? `${feed.nodeName}’s` : 'the outlet’s'} CHIRPS feed (${feed.seriesName})` : 'over the CHIRPS feed’s cells';
	const held = [view?.era5l ? `ERA5-Land ${view.era5l.held} days` : null, view?.imergLate ? `IMERG Late ${view.imergLate.held} days` : null].filter(Boolean);
	// The view reads at most ten years: say so when the record is longer.
	const span = view?.window && view.record && view.window.start > view.record.start ? ` Shown from ${view.window.start}, the last ten years of a record from ${view.record.start}.` : '';
	return `Daily rain in mm ${where}, as each product reads it, before any bias correction.${span} ${held.length ? `Held: ${held.join(', ')}.` : ''}`.trim();
}

export interface ProductDoubleMass {
	product: 'era5l' | 'imerg_late';
	label: string;
	dm: DoubleMass;
}

/**
 * The double mass of catchment rain against each product (§2.10a), as a run
 * checks it (engine gapRain.ts: the product in CHIRPS' place). A product with
 * too few water years for the check is left out (IMERG's 30 days always are).
 */
export function productDoubleMass(catchment: DailySeries | null, view: GapRainView | null, zeroRain?: ZeroRainSettings, dq?: DataQualitySettings): ProductDoubleMass[] {
	if (!catchment || !view) return [];
	const out: ProductDoubleMass[] = [];
	const check = (product: ProductDoubleMass['product'], s: { startDate: string; values: (number | null)[] } | null) => {
		if (!s) return;
		const dm = doubleMass({ rain_catchment_mm: catchment, rain_chirps_mm: { startDate: s.startDate, values: s.values } }, zeroRain, dq);
		if (dm && dm.years.length) out.push({ product, label: GAP_PRODUCT_LABEL[product], dm });
	};
	check('era5l', view.era5l);
	check('imerg_late', view.imergLate);
	return out;
}

/** The credits the view's values carry: ERA5-Land's and IMERG Late's (each version), read `today`. */
export function viewCredits(view: GapRainView | null, today: string): RainCredit[] {
	return rainCredits({ era5l: !!view?.era5l, imergVersions: imergVersions(view) }, today);
}
