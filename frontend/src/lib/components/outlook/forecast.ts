// The forecast-conditioned outlook's view model (issue #620 step 7, docs/ui.md
// § Seasonal outlook, docs/model.md §2.15d): the chance of each restriction
// level on each review date from the C3S seasonal forecasts beside past
// weather's (the ESP's), which of the two leads by the hindcast skill gate,
// the systems and members used, and the Copernicus credit with the
// contributing centres. The numbers are the engine's (outlook/forecast.ts
// runForecastOutlook, run by the backend's outlook job, fed by
// backend/src/outlooks/c3s.ts); this module only words them. The workspace's
// own English, like the rest of the panel.
import { c3sSeasonalCredit } from '@water-management/engine/credits';
import type { OutlookForecast } from '#lib/api/types.js';
import { fmtDay, fmtNum, fmtPct } from '#lib/format/number.js';

/** One outcome on a review date: its name, its storage range (bands only), and its chance from each side. */
export interface ForecastChanceRow {
	id: string;
	label: string;
	/** Bands: the band's range of total storage; a rule's level: "below 40 % of capacity"; null for "No restriction". */
	range: string | null;
	forecast: string;
	esp: string;
}

export interface ForecastDate {
	reviewDate: string;
	/** "Restriction levels (Settings → Drought restrictions)" or "Storage bands (the review triggers’ terciles)". */
	basis: string;
	rows: ForecastChanceRow[];
}

export type ForecastView =
	| { kind: 'off'; message: string; notes: string[] }
	| {
			kind: 'ready';
			leads: 'forecast' | 'esp';
			/** What leads and why, in words: the skill gate. */
			leadText: string;
			/** The hindcast skill score, or why there is none. */
			skill: string;
			/** The columns in the order shown: the leading side first. */
			columns: { key: 'forecast' | 'esp'; label: string }[];
			dates: ForecastDate[];
			/** "Forecasts from 1 May 2021, the newest issued by the decision date (1 Jun 2021)." */
			init: string;
			/** Each system used: "ecmwf-51: 3 members, issued 6 May 2021, weight 50%, hindcast 1993–2016, each month fitted on at least 24 years". */
			systems: string[];
			/** Systems not used, and not issued by the decision date, with why. */
			leftOut: string[];
			/** "Averaged over the catchment boundary (1 cell of 1°)". */
			area: string;
			/** The chance is of dam storage only. */
			storageOnly: string;
			credit: string[];
			warnings: string[];
	  };

const chance = (v: number) => fmtPct(v, 0);
const m3 = (v: number) => `${fmtNum(v)} m³`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), 2)}`;

/** Why the forecast part didn't run, when its message doesn't say more. */
const OFF: Record<NonNullable<OutlookForecast['reason']>, string> = {
	noForecast: 'No seasonal forecast issued by the decision date is held, so the outlook is past weather (the ESP) alone.',
	noHindcast: 'The data copy holds no hindcast to calibrate the forecasts on, so the outlook is past weather (the ESP) alone.',
	noQualifyingSystem: 'No forecast system has 20 hindcast years the record covers, so the outlook is past weather (the ESP) alone.',
	noDams: 'The project has no farm dam, so there is no storage to give a restriction level by.',
	noAnalogues: 'No forecast member could be matched to a past year of the record.',
	levelProblems: 'The forecasts could not be run on this base run.',
	noArea: 'The forecasts can’t be averaged over the catchment: draw its boundary, or the units’ polygons, on the Map.',
	failed: 'The forecast part couldn’t be run.'
};

/** The forecast-conditioned outlook in words, or null when the outlook has none (another method, or an older one). */
export function buildForecastView(f: OutlookForecast | undefined | null): ForecastView | null {
	if (!f) return null;
	const notes = [
		...(f.source?.notIssued.length ? [`Not issued by the decision date: ${f.source.notIssued.map((s) => `${s.system} (${fmtDay(s.issuedOn)})`).join(', ')}.`] : []),
		...(f.source?.notes ?? [])
	];
	if (f.status !== 'ready') return { kind: 'off', message: f.message ?? (f.reason ? OFF[f.reason] : OFF.failed), notes };
	const skill = f.skill;
	const score = skill?.crpss ?? null;
	const leads = f.leads;
	const leadText =
		leads === 'forecast'
			? `The forecasts scored better than past weather over ${plural(skill!.nYears, 'hindcast year')} (CRPSS ${signed(score!)}), so they lead.`
			: score !== null
				? `No better than past weather: over ${plural(skill!.nYears, 'hindcast year')} the forecasts scored ${signed(score)} (CRPSS at or below 0), so past weather leads and the forecasts are shown beside it.`
				: `No better than past weather can be shown: ${skill?.reason ?? 'the forecasts weren’t scored.'} Past weather leads and the forecasts are shown beside it.`;
	const skillText =
		score !== null
			? `Hindcast skill: CRPSS ${signed(score)} for the dam storage at the season’s end, against past weather, over ${plural(skill!.nYears, 'year')} (${skill!.years[0]?.year}–${skill!.years.at(-1)?.year}).`
			: `Hindcast skill: not scored. ${skill?.reason ?? ''}`.trim();
	const forecastCol = { key: 'forecast' as const, label: 'Seasonal forecasts' };
	const espCol = { key: 'esp' as const, label: 'Past weather (every year alike)' };
	const dates: ForecastDate[] = f.chances.map((d, i) => {
		const esp = f.espChances[i];
		return {
			reviewDate: fmtDay(d.reviewDate),
			basis: d.basis === 'rule' ? 'Restriction levels (Settings → Drought restrictions)' : 'Total dam storage, in the review triggers’ bands (no drought restriction rule is set)',
			rows: d.categories.map((c, k) => ({
				id: c.id,
				label: d.basis === 'bands' && c.fromM3 !== null && c.toM3 !== null ? `${m3(c.fromM3)} – ${m3(c.toM3)}` : c.label,
				range: d.basis === 'rule' ? (c.belowPct === null ? null : `storage below ${fmtPct(c.belowPct, 0)} of capacity`) : k === 0 ? 'fullest' : k === d.categories.length - 1 ? 'emptiest' : null,
				forecast: chance(c.chance),
				esp: esp?.categories[k] ? chance(esp.categories[k]!.chance) : '–'
			}))
		};
	});
	const hc = new Map((f.source?.hindcasts ?? []).map((h) => [h.system, h]));
	const issued = new Map((f.source?.issued ?? []).map((s) => [s.system, s.issuedOn]));
	const used = f.systems.filter((s) => s.used);
	const systems = used.map((s) => {
		const h = hc.get(s.system);
		const years = s.months.length ? Math.min(...s.months.map((m) => m.years.length)) : 0;
		return [
			`${s.system}: ${plural(s.members, 'member')}`,
			issued.has(s.system) ? `issued ${fmtDay(issued.get(s.system)!)}` : null,
			`weight ${fmtPct(s.weight, 0)}`,
			h ? `hindcast ${h.years[0]}–${h.years.at(-1)}, each month fitted on at least ${years} years` : null
		]
			.filter(Boolean)
			.join(', ');
	});
	const leftOut = [...f.systems.filter((s) => !s.used).map((s) => `${s.system}: ${s.reason ?? 'not used'}`), ...notes];
	const area = f.area
		? `Averaged over the ${f.area.source === 'boundary' ? 'catchment boundary' : 'units’ polygons together'} (${plural(f.area.cells, '1° cell')}), then mapped onto this run’s own monthly rain.`
		: '';
	return {
		kind: 'ready',
		leads,
		leadText,
		skill: skillText,
		columns: leads === 'forecast' ? [forecastCol, espCol] : [espCol, forecastCol],
		dates,
		init: `Forecasts from ${fmtDay(`${f.init}-01`)}, the newest issued by the decision date (${fmtDay(f.decisionDate)}).`,
		systems,
		leftOut,
		area,
		storageOnly:
			'The chance is of the dam storage on the review date only, at full demand: the rule’s EWR trigger, a filling dam’s milder reading and a level held until the next review are not in it.',
		credit: c3sSeasonalCredit(
			used.map((s) => s.system),
			f.source?.fetchedAt ?? f.decisionDate
		),
		warnings: f.warnings
	};
}
