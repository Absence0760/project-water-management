// The climate-state outlook's view model (issue #620, docs/ui.md § Seasonal
// outlook, docs/model.md §2.15c): this season's ENSO and SAM state, the past
// seasons nearest it and why (their ONI and AAO), and what the dams and the
// river did in those seasons beside every year (the ESP). The numbers are
// the engine's (outlook/climate.ts selectClimateAnalogues and
// climateConditionedOutlook, run by the backend's outlook job); this module
// only words them. The workspace's own English, like the rest of the panel.
import { CLIMATE_INDEX_IDS, describePlanningFigure, type ClimateIndexId, type OutlookStat } from '@water-management/engine';
import type { OutlookResult } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** ONI's 3-month seasons by centre month (January = DJF), as CPC names them. */
const ONI_SEASONS = ['DJF', 'JFM', 'FMA', 'MAM', 'AMJ', 'MJJ', 'JJA', 'JAS', 'ASO', 'SON', 'OND', 'NDJ'];

/** A signed index value: "+0.45", "−1.20" (a real minus sign). */
export const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), 2, false)}`;

/**
 * The months an index was read over, in words: ONI by its 3-month season
 * ("JAS 2018", centred on August), AAO by its months ("Jul–Sep 2018").
 */
export function windowText(id: ClimateIndexId, from: string, to: string): string {
	const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
	const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
	if (id === 'oni' && from === to) return `${ONI_SEASONS[tm - 1]} ${ty}`;
	if (from === to) return `${MONTHS[tm - 1]} ${ty}`;
	return fy === ty ? `${MONTHS[fm - 1]}–${MONTHS[tm - 1]} ${ty}` : `${MONTHS[fm - 1]} ${fy} – ${MONTHS[tm - 1]} ${ty}`;
}

export interface ClimateYearRow {
	label: string;
	oni: string;
	aao: string;
	/** In standard deviations: "0.31". */
	distance: string;
}

export interface ClimateLevelRow {
	id: string;
	label: string;
	/** Season-end storage across the chosen years, and across every year (the ESP). */
	storage: { median: string; band: string };
	storageAll: { median: string; band: string };
	/** Years the requirement was met in full: of the chosen, and of every year. */
	yearsMet: string;
	yearsMetAll: string;
}

export type ClimateView =
	| { kind: 'problem'; message: string; state: string | null; source: string | null }
	| {
			kind: 'ready';
			/** This season's state: "ONI JAS 2018 +0.45; AAO Jul–Sep 2018 −0.31." */
			state: string;
			/** How the years were chosen. */
			how: string;
			/** The headline: "In the 13 past seasons nearest this one, the dams ended at …". */
			headline: string | null;
			rows: ClimateLevelRow[];
			planning: string;
			chosen: ClimateYearRow[];
			others: ClimateYearRow[];
			missing: string | null;
			source: string | null;
			stepped: string | null;
	  };

const statText = (s: OutlookStat | null, f: (v: number) => string) => (s ? { median: f(s.p50), band: `${f(s.p10)} – ${f(s.p90)}` } : { median: '–', band: '' });
const m3 = (v: number) => `${fmtNum(v)} m³`;
const wyLabel = (wy: number) => `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`;
const LABEL: Record<ClimateIndexId, string> = { oni: 'ONI', aao: 'AAO' };

/** The climate-state outlook in words, or null when the outlook has none (method esp, or an older one). */
export function buildClimateView(result: Pick<OutlookResult, 'climate' | 'levels' | 'nYears' | 'metric'>): ClimateView | null {
	const c = result.climate;
	if (!c) return null;
	const sel = c.selection;
	const state = sel.indices.length ? `${sel.indices.map((w) => `${w.label} ${windowText(w.id, w.from, w.to)} ${signed(w.value)}`).join('; ')}.` : null;
	const held = CLIMATE_INDEX_IDS.filter((id) => c.source[id]);
	const source = held.length
		? `Indices: NOAA Climate Prediction Center, ${held.map((id) => `${LABEL[id]} to ${windowText('aao', c.source[id]!.through, c.source[id]!.through)}`).join(', ')}.`
		: null;
	if (sel.problem || !c.outlook) return { kind: 'problem', message: sel.problem?.message ?? 'No past seasons could be matched to this one.', state, source };
	const o = c.outlook;
	const reserve = o.metric === 'reserveMonthsMet';
	const met = (n: number, of: number) => (reserve ? `Reserve met in every month in ${n} of ${of} years` : `EWR met on every day in ${n} of ${of} years`);
	const rows: ClimateLevelRow[] = o.levels
		.filter((l) => !l.problems.length)
		.map((l) => {
			const all = result.levels.find((x) => x.id === l.id);
			return {
				id: l.id,
				label: l.label,
				storage: statText(l.seasonEndStorageM3, m3),
				storageAll: statText(all?.seasonEndStorageM3 ?? null, m3),
				yearsMet: met(l.yearsEwrMet, l.nYears),
				yearsMetAll: all ? met(all.yearsEwrMet, all.nYears) : '–'
			};
		});
	const first = rows[0];
	const headline =
		first && first.storage.median !== '–'
			? `In the ${sel.k} past seasons nearest this one, the dams ended at ${first.storage.median} (10–90 %: ${first.storage.band}) at ${first.label}, against ${first.storageAll.median} in all ${result.nYears} years.`
			: null;
	const row = (y: (typeof sel.years)[number]): ClimateYearRow => ({ label: y.label, oni: signed(y.values.oni), aao: signed(y.values.aao), distance: fmtNum(y.distance, 2, false) });
	const stepped = sel.indices.filter((w) => w.lagMonths > 0);
	return {
		kind: 'ready',
		state: state!,
		how: `The ${sel.k} of ${sel.nCandidates} past seasons whose ONI and AAO over the same months were nearest this one’s (each index in standard deviations across those seasons, weighted equally).`,
		headline,
		rows,
		planning: describePlanningFigure(o),
		chosen: sel.years.filter((y) => y.chosen).map(row),
		others: sel.years.filter((y) => !y.chosen).map(row),
		missing: sel.missing.length ? `Not compared (an index doesn’t reach their months): ${sel.missing.map(wyLabel).join(', ')}.` : null,
		source,
		stepped: stepped.length
			? stepped.map((w) => `The ${w.label} is read ${w.lagMonths} month${w.lagMonths === 1 ? '' : 's'} earlier than usual, in every year alike: the copy didn’t hold its newest month yet.`).join(' ')
			: null
	};
}
