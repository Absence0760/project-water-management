// A unit's drawer → "Actual ET from satellite" (issue #623; docs/ui.md § Farm
// drawer, docs/model.md §2.10o). The unit's dekads of satellite actual ET
// (FAO WaPOR v3) beside the run's crop ET and the irrigation it delivered to
// the crop, as the API compared them (backend water-use/observed/compare.ts).
// Pure: the fold's line, why there is nothing (the check off, no parcels, none
// read yet), which source is shown, the summary sentence, the season and dekad
// rows, and the CSV with the credit on its first line.
import type { EtObserved, EtPoint, EtSkip, EtSource, EtSourceResult, EtTotals } from '#lib/api/types.js';
import { fmtDay, fmtNum } from '#lib/format/number.js';
import { toCsv } from '#lib/spreadsheet/paste/grid.js';

/**
 * The credits, mirrored from backend water-use/observed/upstream.ts (WAPOR_ATTRIBUTION, SSEBOP_ATTRIBUTION). The
 * panel shows the API's own `attribution`; these name a source before any value is loaded.
 */
export const ET_ATTRIBUTION: Record<EtSource, string> = { wapor: 'FAO WaPOR v3, CC BY 4.0', ssebop: 'USGS FEWS NET SSEBop v6, CC0' };

export const SOURCE_WORDS: Record<EtSource, string> = { wapor: 'WaPOR', ssebop: 'SSEBop' };

export const SKIP_WORDS: Record<EtSkip, string> = {
	'partly-seen': 'partly seen (cloud or a gap)',
	'partial-dekad': 'the run covers only part of it',
	'outside-run': 'outside the run',
	'no-area': 'nothing planted in the run',
	'no-run': 'no run to compare with',
	'no-series': 'the run is from an older version: run it again'
};

/** Dekads shown before "Show all". */
export const DEKADS_SHOWN = 6;

const m3 = (v: number | null) => (v === null ? '–' : `${fmtNum(v)} m³`);
/** A bias as a signed percentage: + means the model uses more. */
export function fmtBias(b: number | null): string {
	if (b === null) return '–';
	// Rounded before the sign, so 0.3 reads "0%", never "+0%".
	const r = Math.round(b);
	return `${r > 0 ? '+' : ''}${fmtNum(r, 0)}%`;
}
const dekads = (n: number) => `${fmtNum(n)} dekad${n === 1 ? '' : 's'}`;

/** The source the panel leads with: WaPOR when it has any, else the first. */
export const leadSource = (data: EtObserved | null): EtSourceResult | null => data?.sources.find((s) => s.source === 'wapor') ?? data?.sources[0] ?? null;

/** The source shown: the one picked in the switch while the unit has it, else the lead. */
export const shownSource = (data: EtObserved | null, picked: EtSource | null): EtSourceResult | null =>
	(picked && data?.sources.find((s) => s.source === picked)) || leadSource(data);

/** The switch's label for a source: its name and how many dekads it has. */
export const sourceLabel = (s: EtSourceResult) => `${SOURCE_WORDS[s.source]} (${dekads(s.points.length)})`;

/** Why a unit has no observations: the check off on this site (with or without parcels), no parcels linked, or none read yet. */
export type EtEmpty = 'off' | 'off-no-parcels' | 'no-parcels' | 'waiting';

export function emptyCase(data: Pick<EtObserved, 'enabled' | 'parcels'>): EtEmpty {
	if (!data.enabled) return data.parcels > 0 ? 'off' : 'off-no-parcels';
	return data.parcels > 0 ? 'waiting' : 'no-parcels';
}

const parcelsWords = (n: number) => `${fmtNum(n)} farm parcel${n === 1 ? '' : 's'}`;

/** What the empty panel says, for each reason. */
export function emptyWords(data: Pick<EtObserved, 'enabled' | 'parcels' | 'name'>): string {
	const { name } = data;
	const how = `read each dekad from satellite (${ET_ATTRIBUTION.wapor}) and compared here with the model’s crop water use`;
	switch (emptyCase(data)) {
		case 'off':
			return `The satellite check of actual ET is off on this site (it is off by default). Once it is switched on, the ${parcelsWords(data.parcels)} linked to ${name} on the Map ${data.parcels === 1 ? 'is' : 'are'} ${how}.`;
		case 'off-no-parcels':
			return `The satellite check of actual ET is off on this site (it is off by default), and no farm parcels are linked to ${name} on the Map. Once it is on, the parcels linked to a unit are ${how}.`;
		case 'no-parcels':
			return `No farm parcels are linked to ${name} on the Map, so there is nothing for the satellite to read. Draw ${name}’s parcels on the Map, or link them to it; their actual ET is then ${how}.`;
		case 'waiting':
			return `${parcelsWords(data.parcels)} ${data.parcels === 1 ? 'is' : 'are'} linked to ${name}, but no dekad has been read for ${data.parcels === 1 ? 'it' : 'them'} yet. Each dekad is published about three days after it ends and read newest first, so the first should show within a day.`;
	}
}

/** The fold's line with no observations. */
const EMPTY_LINE: Record<EtEmpty, string> = {
	off: 'off on this site',
	'off-no-parcels': 'off on this site',
	'no-parcels': 'no farm parcels linked',
	waiting: 'none read yet'
};

/** The fold's one line, for the source shown. */
export function etLine(data: EtObserved | null, loading: boolean, error: string | null, picked: EtSource | null = null): string {
	if (error) return 'couldn’t be loaded';
	if (loading) return 'loading…';
	const s = shownSource(data, picked);
	if (!s) return data ? EMPTY_LINE[emptyCase(data)] : 'no observations';
	const t = s.summary;
	if (!t.compared) return `${dekads(s.points.length)} observed, none compared`;
	return `${dekads(t.compared)} compared · crop ET ${fmtBias(t.etBiasPct)} · irrigation ${fmtBias(t.irrigationBiasPct)}`;
}

/** What the totals say, in a sentence: which way the model leans and how often it agrees. */
export function summaryWords(t: EtTotals, withinShare: number): string | null {
	if (!t.compared) return null;
	const lean = (b: number | null, what: string) =>
		b === null ? `No ${what} was observed.` : Math.abs(b) < 0.5 ? `The model’s ${what} matches the satellite’s.` : `The model’s ${what} is ${fmtNum(Math.abs(b), 0)}% ${b > 0 ? 'above' : 'below'} the satellite’s.`;
	const share = (s: number | null) => (s === null ? '–' : `${fmtNum(s * 100, 0)}%`);
	return [
		`Over ${dekads(t.compared)}:`,
		lean(t.etBiasPct, 'crop ET'),
		lean(t.irrigationBiasPct, 'irrigation'),
		`Within ±${fmtNum(withinShare * 100, 0)}%: ${share(t.etWithinShare)} of dekads for crop ET, ${share(t.irrigationWithinShare)} for irrigation.`
	].join(' ');
}

/** The observed area against the planted area, when they differ by more than the threshold (a check on the areas). */
export function areaWords(s: EtSourceResult, plantedAreaM2: number | null): string | null {
	if (!s.area || !s.area.differs || !plantedAreaM2) return null;
	const what = s.area.mask === 'cropland' ? 'cropland inside the unit’s parcels' : 'the unit’s parcels';
	return `The satellite read ${fmtNum(s.area.areaM2 / 10_000, 1)} ha of ${what}; the model plants ${fmtNum(plantedAreaM2 / 10_000, 1)} ha. Check the planted areas and the parcels.`;
}

export interface SeasonRow {
	key: string;
	label: string;
	dekads: string;
	observedEt: string;
	modelledEt: string;
	etBias: string;
	observedIrrigation: string;
	modelledIrrigation: string;
	irrigationBias: string;
}

/** One row per half water year, oldest first (the API's order). */
export const seasonRows = (s: EtSourceResult): SeasonRow[] =>
	s.seasons.map((x) => ({
		key: `${x.waterYear}-${x.half}`,
		label: x.label,
		dekads: `${fmtNum(x.compared)} of ${fmtNum(x.compared + x.skipped)}`,
		observedEt: x.compared ? m3(x.observedEtM3) : '–',
		modelledEt: x.compared ? m3(x.modelledEtM3) : '–',
		etBias: fmtBias(x.etBiasPct),
		observedIrrigation: x.compared ? m3(x.observedIrrigationM3) : '–',
		modelledIrrigation: x.compared ? m3(x.modelledIrrigationM3) : '–',
		irrigationBias: fmtBias(x.irrigationBiasPct)
	}));

export interface DekadRow {
	key: string;
	dekad: string;
	eta: string;
	observedEt: string;
	modelledEt: string;
	observedIrrigation: string;
	modelledIrrigation: string;
	note: string;
	/** A compared dekad outside the band on either comparison. */
	outside: boolean;
}

function note(p: EtPoint): string {
	if (!p.compared) return `Not compared: ${SKIP_WORDS[p.skip!]}`;
	const parts: string[] = [];
	if (!p.etWithin) parts.push('crop ET differs');
	if (!p.irrigationWithin) parts.push('irrigation differs');
	return parts.length ? parts.join(', ') : 'Agrees';
}

/** "1–10 Jan 2020": a dekad never crosses a month. */
export const dekadLabel = (dekad: string, end: string) => `${Number(dekad.slice(8, 10))}–${fmtDay(end)}`;

/** Newest first. */
export const dekadRows = (s: EtSourceResult): DekadRow[] =>
	[...s.points].reverse().map((p) => ({
		key: `${p.source}-${p.dekad}`,
		dekad: dekadLabel(p.dekad, p.end),
		eta: `${fmtNum(p.etaMmDay, 1)} mm/day`,
		observedEt: m3(p.observedEtM3),
		modelledEt: m3(p.modelledEtM3),
		observedIrrigation: m3(p.observedIrrigationM3),
		modelledIrrigation: m3(p.modelledIrrigationM3),
		note: note(p),
		outside: p.compared && (p.etWithin === false || p.irrigationWithin === false)
	}));

/** The comparison as CSV, every source's dekads, the credits on the first line (CC BY 4.0 asks for it wherever the values go). */
export function etCsv(data: EtObserved): string {
	const credits = data.sources.map((s) => s.attribution).join('; ');
	const head = [
		'source',
		'dekad',
		'end',
		'days',
		'eta_mm_day',
		'valid_share',
		'area_m2',
		'mask',
		'observed_et_m3',
		'modelled_crop_et_m3',
		'requirement_full_supply_m3',
		'effective_rain_m3',
		'observed_irrigation_m3',
		'modelled_irrigation_to_crop_m3',
		'supplied_m3',
		'compared',
		'not_compared_because'
	];
	const rows = data.sources.flatMap((s) =>
		s.points.map((p) => [
			s.source,
			p.dekad,
			p.end,
			p.days,
			p.etaMmDay,
			p.validShare,
			p.areaM2,
			p.mask,
			p.observedEtM3,
			p.modelledEtM3,
			p.requirementM3,
			p.effectiveRainM3,
			p.observedIrrigationM3,
			p.modelledIrrigationM3,
			p.suppliedM3,
			p.compared ? 'yes' : 'no',
			p.skip ?? ''
		])
	);
	const run = data.run ? `run "${data.run.label}"` : 'no run';
	// A raw first line, not a cell: the credit holds a comma, and a quoted cell wouldn't start with `#`. It starts
	// with `#`, so a spreadsheet never reads it as a formula.
	const line = `# ${data.name}: actual ET ${credits} · compared with ${run} · volumes on the run's planted area`.replace(/\s+/g, ' ');
	return `${line}\r\n${toCsv([head, ...rows])}`;
}

/** The CSV's file name: the unit's name, made safe. */
export const etCsvName = (name: string) => `${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'unit'}-actual-et.csv`;
