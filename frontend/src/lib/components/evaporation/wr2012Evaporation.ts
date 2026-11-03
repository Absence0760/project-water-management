// Model settings → Demand → "Where the A-pan row comes from" → "WR2012 Pitman
// configuration, per quaternary" (docs/ui.md § Demand, docs/maps.md § WR2012
// evaporation by quaternary): WR2012's monthly S-pan (runoff modules) and
// A-pan (irrigation modules) for each quaternary the catchment boundary
// overlaps, and the catchment's area-weighted rows. The A-pan is used as it
// stands; the server re-derives everything on Use. This only words it.
import type { Wr2012EvaporationProposal, Wr2012EvaporationQuaternary } from '#lib/api/index.js';
import { fmtNum } from '#lib/format/number.js';

type Evaporation = NonNullable<Wr2012EvaporationProposal['evaporation']>;

/** A share of the catchment, as a whole percentage ("75 %", or "< 1 %" for a sliver). */
export const shareText = (share: number) => (share > 0 && share < 0.005 ? '< 1 %' : `${fmtNum(Math.round(share * 100))} %`);

/** A row's 12 months, as a year's total in whole mm. */
export const annualMm = (row: readonly number[]) => Math.round(row.reduce((a, b) => a + b, 0));

/** A-pan ÷ S-pan over the year, two decimals, or '–'. */
export const ratioText = (q: Pick<Wr2012EvaporationQuaternary, 'spanMm' | 'apanMm'>) =>
	q.spanMm && q.apanMm ? fmtNum(Math.round((annualMm(q.apanMm) / annualMm(q.spanMm)) * 100) / 100, 2, true) : '–';

/** How the modules agree, in a phrase: "1 module", "3 modules agree", "2 of 3 agree; others 1 620 mm". */
export function agreementText(a: Wr2012EvaporationQuaternary['span']): string {
	if (!a) return '–';
	if (a.agree >= a.modules) return a.modules === 1 ? '1 module' : `${fmtNum(a.modules)} modules agree`;
	return `${fmtNum(a.agree)} of ${fmtNum(a.modules)} agree${a.othersMm.length ? `; others ${a.othersMm.map((x) => `${fmtNum(Math.round(x))} mm`).join(', ')}` : ''}`;
}

/** What the catchment's A-pan row is, in a sentence: one quaternary's row, or the area-weighted mean, and the part left out. */
export function meanText(e: Evaporation): string {
	const used = e.quaternaries.filter((q) => q.apanMm);
	const what = used.length === 1 ? `${used[0]!.code}’s row: the catchment lies in it` : `the mean of the ${fmtNum(used.length)} quaternaries’ rows, each weighted by its share of the catchment’s area`;
	const left = 1 - e.apanCoverage;
	return left >= 0.005
		? `The catchment’s A-pan is ${what}. ${shareText(left)} of the catchment lies in quaternaries with no irrigation module (A-pan) loaded, or in none, and is left out of the mean.`
		: `The catchment’s A-pan is ${what}.`;
}

/** The confirmation before Use: what is written, from where, and what reads it. */
export function useMessage(e: Evaporation, dailyApan: Wr2012EvaporationProposal['settings']['dailyApan']): string {
	const used = e.quaternaries.filter((q) => q.apanMm);
	const from = used.length === 1 ? `quaternary ${used[0]!.code}’s irrigation modules` : `the irrigation modules of ${used.map((q) => `${q.code} (${shareText(q.share)})`).join(', ')}, area-weighted`;
	const what = `The A-pan row becomes ${fmtNum(annualMm(e.apanMm!))} mm a year, WR2012’s A-pan from ${from}, as it stands.`;
	const reads = 'Irrigation demand, dam evaporation and, under pan coefficient × A-pan, GR4J read it; a GR4J fit made before is then marked “Forcing changed since fit”.';
	const daily = dailyApan.length ? ` The daily A-pan series “${dailyApan[0]!.name}” still replaces the monthly row on every day it covers.` : '';
	return `${what} ${reads}${daily}`;
}
