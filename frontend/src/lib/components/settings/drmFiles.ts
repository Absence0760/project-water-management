// Desktop Reserve Model output files (issue #455), uploaded on Settings → the
// daily EWR at the outlet and → Reserve rule tables: the rule curves (.rul)
// and the summary (.tab), both plain text. Pure parsers, the unit
// conversions, the mapping onto a rule table and the daily EWR's source, and
// synthetic example files of the same layout (invented numbers).
//
// .rul: header lines ("Desktop Version 2, Generated on …", "Regional Type : …",
// "Ecological Category = B"), a unit line ("Data are given in m^3/s mean
// monthly flow", or in an older file "… m^3 * 10^6 monthly flow volume", Mm³
// a month), a "% Points" line and the points ("10% 20% … 99%"), then three
// blocks of 12 month rows (a month name, then one number per point): the
// total Reserve (unlabelled, right after the points), "Reserve Flows without
// High Flows" and "Natural Duration curves".
//
// .tab: "MAR = 92.4"-style and the other annual lines, "Ecological Category = B",
// and the "Monthly Distributions (Mill. cu. m.)" table: per month the natural
// mean, SD and CV, then the modified flows: low flows (maintenance,
// drought), high flows (maintenance) and the total flows (maintenance), the
// last column, in Mm³ a month.
import type { ExampleFile } from '$lib/components/common/formatHelp';
import { DEFAULT_ASSURANCE_POINTS, EWR_PERCENTILE_POINTS, type EwrDailySource, type EwrRuleTable } from '@water-management/engine';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Water-year row (Oct = 0) of a three-letter month name, or null. */
const wyRow = (name: string): number | null => {
	const m = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
	return m < 0 ? null : (m + 3) % 12;
};
const WY = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
/** Days in each water-year month, February 28 (the DRM's convention, and the matching workbook's). */
export const DRM_MONTH_DAYS = [31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30];

/** Mm³ in a water-year month → that month's mean flow, m³/s (February 28 days). */
export const mcmMonthToM3s = (mcm: number, wy: number): number => (mcm * 1e6) / (DRM_MONTH_DAYS[wy]! * 86_400);

export interface RulFile {
	kind: 'rul';
	/** The file's unit: m³/s mean monthly flow, or Mm³ a month. */
	unit: 'm3s' | 'mcm';
	category: string | null;
	generated: string | null;
	/** The % points (10 … 99). */
	points: number[];
	/** The total Reserve, 12 rows (Oct … Sep) × the points, in `unit`. */
	total: number[][];
	/** "Reserve Flows without High Flows" (the low flows), or null when the file has no such block. */
	lowFlow: number[][] | null;
	/** "Natural Duration curves", or null when the file has no such block. */
	natural: number[][] | null;
}

export interface TabFile {
	kind: 'tab';
	/** The natural MAR, Mm³ a year ("MAR = …"), or null. */
	marMm3: number | null;
	category: string | null;
	generated: string | null;
	/** The monthly table's last column, "Total Flows, Maint.", Mm³ a month, Oct … Sep. */
	totalMaintMcm: number[];
	/** The same, converted to each month's mean flow, m³/s (February 28 days). */
	totalMaintM3s: number[];
}

export type DrmParse<T> = T | { error: string };

const lineOf = (i: number) => `line ${i + 1}`;
const numbersOf = (text: string) => text.trim().split(/\s+/).filter(Boolean).map(Number);
const CATEGORY = /Ecological\s+Category\s*=\s*([A-F](?:\s*\/\s*[A-F])?)/i;
const GENERATED = /Generated\s+on\s+(\S+)/i;
const first = (lines: string[], re: RegExp): string | null => {
	for (const l of lines) {
		const m = re.exec(l);
		if (m) return m[1]!.replace(/\s+/g, '').toUpperCase();
	}
	return null;
};
const generatedOf = (lines: string[]): string | null => {
	for (const l of lines) {
		const m = GENERATED.exec(l);
		if (m) return m[1]!;
	}
	return null;
};
const split = (text: string) => text.replace(/^﻿/, '').split(/\r\n|\r|\n/);

/** Which DRM file a text is, by its content: 'rul', 'tab', or null (a CSV or anything else). */
export function drmKind(text: string): 'rul' | 'tab' | null {
	if (/^\s*Data are given in/im.test(text) && /%\s*Points/i.test(text)) return 'rul';
	if (/Monthly\s+Distributions/i.test(text) && /^\s*MAR\s*=/im.test(text)) return 'tab';
	return null;
}

/**
 * Read 12 month rows (in any order, each once) from `at` on, `width` numbers
 * each, skipping blank lines before the first. Errors name the line.
 */
function monthBlock(lines: string[], at: number, width: number, label: string): DrmParse<{ rows: number[][]; next: number }> {
	let i = at;
	while (i < lines.length && !lines[i]!.trim()) i++;
	const rows: number[][] = new Array(12);
	const seen = new Set<number>();
	for (let k = 0; k < 12; k++, i++) {
		const line = lines[i];
		if (line === undefined || !line.trim()) return { error: `The ${label} block ends after ${k} month${k === 1 ? '' : 's'} (${lineOf(i)}); it needs 12, Oct … Sep.` };
		const m = /^\s*([A-Za-z]{3,})\s+(.*)$/.exec(line);
		const row = m ? wyRow(m[1]!) : null;
		if (!m || row === null) return { error: `${lineOf(i)}: expected a month row of the ${label} block (a month name, then ${width} numbers), found “${line.trim().slice(0, 60)}”.` };
		const v = numbersOf(m[2]!);
		if (v.length !== width || v.some((x) => !Number.isFinite(x))) return { error: `${lineOf(i)}: the ${m[1]} row of the ${label} block needs ${width} numbers; it has ${v.filter(Number.isFinite).length === v.length ? v.length : 'one that isn’t a number'}.` };
		if (v.some((x) => x < 0)) return { error: `${lineOf(i)}: the ${m[1]} row of the ${label} block has a value below 0.` };
		if (seen.has(row)) return { error: `${lineOf(i)}: ${m[1]} appears twice in the ${label} block.` };
		seen.add(row);
		rows[row] = v;
	}
	return { rows, next: i };
}

/** Read a DRM rule-curve file (.rul). Errors name the line that didn't parse. */
export function parseRulFile(text: string): DrmParse<RulFile> {
	const lines = split(text);
	const unitAt = lines.findIndex((l) => /^\s*Data are given in/i.test(l));
	if (unitAt < 0) return { error: 'No “Data are given in …” line: is this a Desktop Reserve Model rule-curve (.rul) file?' };
	const unitLine = lines[unitAt]!;
	const unit = /m\^?3\s*\/\s*s/i.test(unitLine) ? 'm3s' : /10\^?6|volume/i.test(unitLine) ? 'mcm' : null;
	if (!unit) return { error: `${lineOf(unitAt)}: the unit “${unitLine.trim()}” is neither m^3/s mean monthly flow nor m^3 * 10^6 monthly flow volume.` };
	const pointsAt = lines.findIndex((l, i) => i > unitAt && /%\s*Points/i.test(l));
	if (pointsAt < 0) return { error: 'No “% Points” line after the unit line.' };
	let headAt = pointsAt + 1;
	while (headAt < lines.length && !lines[headAt]!.trim()) headAt++;
	const head = (lines[headAt] ?? '').trim();
	const points = head.split(/\s+/).map((p) => Number(p.replace(/%$/, '')));
	if (!head || points.length < 2 || points.some((p) => !Number.isFinite(p) || p <= 0 || p > 100) || points.some((p, i) => i > 0 && p <= points[i - 1]!)) {
		return { error: `${lineOf(headAt)}: expected the % points (10% 20% … 99%), rising, found “${head.slice(0, 60)}”.` };
	}
	const total = monthBlock(lines, headAt + 1, points.length, 'total Reserve');
	if ('error' in total) return total;
	const blockAfter = (re: RegExp, label: string): DrmParse<number[][] | null> => {
		const at = lines.findIndex((l, i) => i >= total.next && re.test(l));
		if (at < 0) return null;
		const b = monthBlock(lines, at + 1, points.length, label);
		return 'error' in b ? b : b.rows;
	};
	const lowFlow = blockAfter(/Reserve\s+Flows\s+without\s+High\s+Flows/i, 'Reserve Flows without High Flows');
	if (lowFlow && 'error' in lowFlow) return lowFlow;
	const natural = blockAfter(/Natural\s+Duration\s+curves?/i, 'Natural Duration curves');
	if (natural && 'error' in natural) return natural;
	return { kind: 'rul', unit, category: first(lines, CATEGORY), generated: generatedOf(lines), points, total: total.rows, lowFlow: lowFlow as number[][] | null, natural: natural as number[][] | null };
}

/** Read a DRM summary file (.tab). Errors name the line that didn't parse. */
export function parseTabFile(text: string): DrmParse<TabFile> {
	const lines = split(text);
	const marAt = lines.findIndex((l) => /^\s*MAR\s*=/i.test(l));
	let marMm3: number | null = null;
	if (marAt >= 0) {
		const v = Number(/=\s*(\S+)/.exec(lines[marAt]!)?.[1]);
		if (!(Number.isFinite(v) && v > 0)) return { error: `${lineOf(marAt)}: the MAR “${lines[marAt]!.trim()}” isn't a number above 0.` };
		marMm3 = v;
	}
	const tableAt = lines.findIndex((l) => /Monthly\s+Distributions/i.test(l));
	if (tableAt < 0) return { error: 'No “Monthly Distributions” table: is this a Desktop Reserve Model summary (.tab) file?' };
	if (!/Mill\.?\s*cu\.?\s*m|10\^?6/i.test(lines[tableAt]!)) return { error: `${lineOf(tableAt)}: the monthly table isn't in million m³ (Mill. cu. m.).` };
	// The first month row after the table's heading lines.
	let at = tableAt + 1;
	while (at < lines.length && !/^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+[-\d.]/i.test(lines[at]!)) at++;
	if (at >= lines.length) return { error: `The monthly table (${lineOf(tableAt)}) has no month rows.` };
	// Natural mean, SD, CV; low flows maint., drought; high flows maint.; total flows maint.
	const b = monthBlock(lines, at, 7, 'monthly distributions');
	if ('error' in b) return b;
	const totalMaintMcm = b.rows.map((r) => r[6]!);
	return {
		kind: 'tab',
		marMm3,
		category: first(lines, CATEGORY),
		generated: generatedOf(lines),
		totalMaintMcm,
		totalMaintM3s: totalMaintMcm.map((v, wy) => mcmMonthToM3s(v, wy))
	};
}

/** A DRM file of either kind, by its content; null when the text is neither (a CSV or a paste). */
export function parseDrmFile(text: string): DrmParse<RulFile | TabFile> | null {
	const kind = drmKind(text);
	return kind === 'rul' ? parseRulFile(text) : kind === 'tab' ? parseTabFile(text) : null;
}

/** A grid in a .rul file's unit → m³/s (each month's mean flow; February 28 days). */
export const gridToM3s = (grid: number[][], unit: RulFile['unit']): number[][] => (unit === 'm3s' ? grid.map((r) => [...r]) : grid.map((r, wy) => r.map((v) => mcmMonthToM3s(v, wy))));

/** The percentile tables of the daily EWR's source from a .rul file, in m³/s; an error when it lacks a block or the DRM's ten points. */
export function percentileTablesFromRul(rul: RulFile): DrmParse<Pick<EwrDailySource, 'naturalPctM3s' | 'reservePctM3s'>> {
	const want = EWR_PERCENTILE_POINTS.map((p) => Math.round(p * 100));
	if (rul.points.length !== want.length || rul.points.some((p, i) => p !== want[i])) return { error: `The file's % points (${rul.points.join(', ')}) aren't the DRM's ten (${want.join(', ')}).` };
	if (!rul.natural) return { error: 'The file has no “Natural Duration curves” block, which the percentile tables need.' };
	return { naturalPctM3s: gridToM3s(rul.natural, rul.unit), reservePctM3s: gridToM3s(rul.total, rul.unit) };
}

/**
 * A rule table filled from a .rul file: its unit and % points, the total
 * Reserve as the EWR (a total-flow table), the low flows, the natural
 * duration curve, the REC, and a source naming the file when none is
 * typed. The natural-flow choice is kept: the file's curve is there to pick.
 */
export function ruleTableFromRul(t: EwrRuleTable, rul: RulFile, fileName: string): EwrRuleTable {
	const copy = (g: number[][] | null) => (g ? g.map((r) => [...r]) : null);
	return {
		...t,
		component: 'total',
		unit: rul.unit,
		points: [...rul.points],
		ewr: copy(rul.total)!,
		lowFlow: copy(rul.lowFlow),
		natural: copy(rul.natural) ?? (t.naturalSource === 'table' ? rul.total.map((r) => r.map(() => null as unknown as number)) : null),
		category: rul.category ?? t.category ?? null,
		sourceKind: t.sourceKind ?? 'desktop',
		source: t.source.trim() || `Desktop Reserve Model rule curves (${fileName}${rul.generated ? `, generated ${rul.generated}` : ''})`
	};
}

/** What a .tab file fills on a rule table: the determination's natural MAR and the REC. */
export function ruleTableFromTab(t: EwrRuleTable, tab: TabFile): EwrRuleTable {
	return { ...t, ...(tab.marMm3 !== null ? { naturalMarMcm: tab.marMm3 } : {}), category: tab.category ?? t.category ?? null };
}

// ---------------------------------------------------------------------------
// Synthetic example files (invented numbers, the DRM's layout)
// ---------------------------------------------------------------------------

const SEASON = [0.9, 0.5, 0.2, 0.1, 0.1, 0.15, 0.4, 1.3, 2.4, 2.8, 2.1, 1.5];
const f3 = (v: number, w = 8) => v.toFixed(3).padStart(w);

/** A synthetic .rul file in m³/s (or Mm³ a month), CRLF line ends as the DRM writes them. */
export function exampleRulFile(unit: RulFile['unit'] = 'm3s'): string {
	const points = DEFAULT_ASSURANCE_POINTS;
	const toUnit = (m3s: number, wy: number) => (unit === 'm3s' ? m3s : (m3s * DRM_MONTH_DAYS[wy]! * 86_400) / 1e6);
	const block = (f: (wy: number, p: number) => number) => WY.map((m, wy) => `${m}  ${points.map((p) => f3(toUnit(f(wy, p), wy))).join('')}`);
	const natural = (wy: number, p: number) => SEASON[wy]! * (1.6 - (1.5 * p) / 100);
	const low = (wy: number, p: number) => natural(wy, p) * (0.5 - (0.4 * p) / 100);
	const total = (wy: number, p: number) => low(wy, p) + (p <= 50 && SEASON[wy]! > 1 ? 0.2 * SEASON[wy]! : 0);
	return [
		'Desktop Version 2, Generated on 01/01/2026',
		'Summary of IFR rule curves (Desktop Version 2) for : SYNTHETIC EXAMPLE',
		'Regional Type : Synthetic',
		'Ecological Category = C',
		'',
		unit === 'm3s' ? 'Data are given in m^3/s mean monthly flow' : 'Data are given in m^3 * 10^6 monthly flow volume',
		'',
		'Month           % Points',
		`     ${points.map((p) => `${p}%`.padStart(7)).join('')}`,
		...block(total),
		'',
		'Reserve Flows without High Flows',
		...block(low),
		'',
		'Natural Duration curves',
		...block(natural),
		''
	].join('\r\n');
}

/** A synthetic .tab file, CRLF line ends. */
export function exampleTabFile(): string {
	const mean = SEASON.map((s) => s * 4);
	const lowM = mean.map((v) => v * 0.35);
	const drought = mean.map((v) => v * 0.05);
	const high = mean.map((v, i) => (SEASON[i]! > 1 ? v * 0.15 : 0));
	const total = lowM.map((v, i) => v + high[i]!);
	const mar = mean.reduce((a, b) => a + b, 0);
	return [
		'        Desktop Version 2, Generated on 01/01/2026',
		'        Summary of Desktop (Version 2) estimate for Quaternary Catchment Area : SYNTHETIC EXAMPLE',
		'',
		'        Annual Flows (Mill. cu. m or index values):',
		`        MAR               = ${f3(mar)}`,
		'',
		'        Ecological Category = C',
		'',
		'        Monthly Distributions (Mill. cu. m.)',
		'        Distribution Type : Synthetic',
		'',
		'        Month    Natural Flows           Modified Flows (IFR)',
		'                                         Low flows    High Flows Total Flows',
		'               Mean    SD      CV     Maint.  Drought    Maint.    Maint.',
		...WY.map((m, i) => `         ${m} ${f3(mean[i]!)}${f3(mean[i]! * 0.8)}${f3(0.8)}${f3(lowM[i]!, 9)}${f3(drought[i]!)}${f3(high[i]!, 10)}${f3(total[i]!, 10)}`),
		''
	].join('\r\n');
}

/** The example files the "Expected format" note offers (DrmFormatHelp.svelte), plain text, as the DRM writes them. */
export function drmExampleFiles(): ExampleFile[] {
	return [
		{ name: 'drm-example.rul', text: exampleRulFile('m3s'), type: 'text/plain', label: 'Example .rul (m³/s)' },
		{ name: 'drm-example-mcm.rul', text: exampleRulFile('mcm'), type: 'text/plain', label: 'Example .rul (Mm³ a month)' },
		{ name: 'drm-example.tab', text: exampleTabFile(), type: 'text/plain', label: 'Example .tab' }
	];
}

export { WY as DRM_MONTHS };
