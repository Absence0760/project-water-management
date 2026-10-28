// Calibration → Flow calibration → "Evaporation stations" (issue #646 item 6;
// docs/ui.md § Set up the fit, docs/maps.md § Evaporation stations): the
// nearest DWS evaporation stations to the catchment boundary, each one's
// monthly means proposed as the A-pan row. A Class-A pan's means are the
// A-pan as they stand; a Symons pan's only through the S→A equation the user
// picks. The server re-derives everything on Use; this only words it.
import type { EvaporationStationProposal, EvaporationStationProposals, SpanConversionId, StationApan } from '#lib/api/index.js';
import { fmtDay, fmtNum } from '#lib/format/number.js';

export const PAN_LABEL = { class_a: 'Class-A pan', symons: 'Symons pan' } as const;

/** Where the station is, in a phrase. */
export const whereText = (s: Pick<EvaporationStationProposal, 'distanceKm'>) =>
	s.distanceKm === 0 ? 'inside the boundary' : `${fmtNum(s.distanceKm, 1, true)} km from the boundary`;

/** The record's span and completeness, in a phrase. */
export const recordText = (s: Pick<EvaporationStationProposal, 'recordStart' | 'recordEnd' | 'recordYears' | 'completeness'>) =>
	`${s.recordStart.slice(0, 4)}–${s.recordEnd.slice(0, 4)} (${fmtNum(s.recordYears, 1, true)} years), ${fmtNum(Math.round(s.completeness * 100))} % of days read`;

/** The A-pan a station gives under the conversion picked (a Symons pan with none picked gives nothing yet). */
export function chosenApan(s: EvaporationStationProposal, conversion: SpanConversionId | null): StationApan | null {
	if (s.pan === 'class_a') return s.apan;
	if (!conversion) return null;
	return s.conversions?.find((c) => c.id === conversion)?.result ?? null;
}

/** The first station whose record gives 12 means (Class-A, or Symons under some equation), else the first. */
export function defaultStation(p: EvaporationStationProposals): string | null {
	const usable = p.stations.find((s) => (s.pan === 'class_a' ? s.apan?.ok : s.conversions?.some((c) => c.result.ok)));
	return (usable ?? p.stations[0])?.code ?? null;
}

/** The daily series that would stop the station's record being written (the project holds another under another name), or null. */
export const otherDailySeries = (p: EvaporationStationProposals, s: EvaporationStationProposal) => p.settings.dailyApan.find((d) => d.name !== s.seriesName) ?? null;

/** The proposed row is what the settings hold already (to 0.05 mm a month). */
export const sameAsSaved = (saved: readonly number[], proposed: readonly number[]) => saved.length === 12 && saved.every((v, i) => Math.abs(v - proposed[i]!) < 0.05);

const annual = (row: readonly number[]) => Math.round(row.reduce((a, b) => a + b, 0));

/** The confirmation before Use: what is written, from where, and what reads it. */
export function useMessage(s: EvaporationStationProposal, apan: number[], daily: boolean, p: EvaporationStationProposals, conversionLabel: string | null): string {
	const from = `${s.code}${s.name ? ` (${s.name})` : ''}, a ${PAN_LABEL[s.pan]} ${whereText(s)}`;
	const what = `The A-pan row becomes ${fmtNum(annual(apan))} mm a year, the monthly means of ${from}${conversionLabel ? `, converted by the ${conversionLabel}` : ''}.`;
	const reads = 'Irrigation demand, dam evaporation and, under pan coefficient × A-pan, GR4J read it; a GR4J fit made before is then marked “Forcing changed since fit”.';
	const own = p.settings.dailyApan.find((d) => d.name === s.seriesName);
	const series = daily
		? ` Its daily record (${fmtDay(s.recordStart)} to ${fmtDay(s.recordEnd)}) is ${own ? 'written again' : 'written'} as the daily A-pan series “${s.seriesName}”, which replaces the monthly row on every day it covers.`
		: p.settings.dailyApan.length
			? ` The daily A-pan series “${p.settings.dailyApan[0]!.name}” still replaces the monthly row on every day it covers.`
			: '';
	return `${what} ${reads}${series}`;
}
