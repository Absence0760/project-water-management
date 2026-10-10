// Words and table shapes for the Allocations tab (WP-3.10, docs/ui.md
// § Allocations). Pure, unit-tested in allocations.test.ts.
//
// The wording never says "lawful", "unlawful", "compliant" or "illegal": the
// app compares modelled use with a registered volume and leaves the finding to
// the authority (docs/allocations.md § What the comparison is not).
import { allocationStatus, type AllocationComparison, type AllocationMode, type AllocationStatus, type AllocationYear } from '@water-management/engine';
import type { Allocation, AllocationAuthorisation, AllocationCapYears, AllocationPreviewRow, AllocationTotal, AllocationPurpose, AllocationWaterSourceKind, AllocationWaterUse } from '$lib/api/types';
import type { FileFormat } from '$lib/components/common/formatHelp';
import { fmtNum } from '$lib/format/number';

export const AUTHORISATION_LABEL: Record<AllocationAuthorisation, string> = {
	registration: 'Registration (WARMS)',
	licence: 'Licence',
	general_authorisation: 'General authorisation',
	schedule_1: 'Schedule 1 (permissible use)',
	existing_lawful_use_claimed: 'Existing lawful use (claimed, not verified)',
	existing_lawful_use: 'Existing lawful use (verified under s35)'
};

export const PURPOSE_LABEL: Record<AllocationPurpose, string> = {
	irrigation: 'Irrigation',
	domestic: 'Domestic',
	livestock: 'Livestock',
	industry: 'Industry',
	mining: 'Mining',
	municipal: 'Municipal',
	other: 'Other'
};

export const SOURCE_LABEL: Record<AllocationWaterSourceKind, string> = {
	surface: 'Surface water',
	groundwater: 'Groundwater'
};

/** The NWA s21 water use (142, issue #72). */
export const WATER_USE_LABEL: Record<AllocationWaterUse, string> = {
	'21a': 'Taking water (s21a)',
	'21b': 'Storing water in a dam (s21b)'
};

/**
 * A volume's main figure in the list: "120,000 m³/a", or for a storage-only
 * (s21b) row, which registers no take, "Storage only (s21b)".
 */
export const volumeCell = (a: { waterUse: AllocationWaterUse; volumeM3PerYear: number | null }): string => (a.waterUse === '21b' ? 'Storage only (s21b)' : `${fmtNum(a.volumeM3PerYear)} m³/a`);

/**
 * The dam against its registered storage (engine compareAllocations
 * `storage`, issue #72), in words, or null when there is neither. Arithmetic
 * only: whether filling the dam is also a s21(a) take is the hydrologist's
 * question (issue #90).
 */
export function storageSentence(s: AllocationComparison['nodes'][number]['storage'], tolerance: number): string | null {
	const cap = s.modelledCapacityM3;
	if (s.registeredM3 === null && !cap) return null;
	const band = `±${fmtNum(tolerance * 100, 0)} %`;
	if (s.registeredM3 === null) return `Dam capacity in the run ${fmtNum(cap)} m³, with no registered storage (s21b).`;
	if (!cap) return `Registered storage ${fmtNum(s.registeredM3)} m³, with no dam in the run.`;
	const both = `Registered storage ${fmtNum(s.registeredM3)} m³ · dam capacity in the run ${fmtNum(cap)} m³`;
	switch (s.status) {
		case 'over':
			return `${both}: the dam is ${fmtNum(s.differenceM3 ?? 0)} m³ larger than the storage registered for it (outside the ${band} band).`;
		case 'under':
			return `${both}: the dam is ${fmtNum(-(s.differenceM3 ?? 0))} m³ smaller than the storage registered for it (outside the ${band} band).`;
		case 'within':
			return `${both}: within ${band}.`;
		default:
			return `${both}.`;
	}
}

/** Short badge text per status: what the numbers say, not a finding. */
export const STATUS_LABEL: Record<AllocationStatus, string> = {
	over: 'Above registered',
	within: 'Within band',
	under: 'Below registered',
	unregistered: 'No registered volume',
	none: 'No use, none registered'
};

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The calendar months in water-year order (Oct … Sep), as the form lists them. */
export const WATER_YEAR_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const monthShort = (m: number) => MONTH_SHORT[m - 1] ?? String(m);

/**
 * A licence's months of use in words (103, issue #72): runs of consecutive
 * months, over the new year too ("Oct–Mar"), from the first in the water
 * year; "all year" for twelve; '' for none stated.
 */
export function monthsText(months: readonly number[] | null | undefined): string {
	if (!months?.length) return '';
	const set = new Set(months);
	if (set.size >= 12) return 'all year';
	const next = (m: number) => (m % 12) + 1;
	const starts = WATER_YEAR_MONTHS.filter((m) => set.has(m) && !set.has(m === 1 ? 12 : m - 1));
	return starts
		.map((s) => {
			let e: number = s;
			while (set.has(next(e))) e = next(e);
			return e === s ? monthShort(s) : `${monthShort(s)}–${monthShort(e)}`;
		})
		.join(', ');
}

/** A volume's licence conditions in one line for the list, or null when it states none. */
export function conditionsSummary(a: Pick<Allocation, 'months' | 'maxRateM3s' | 'conditions'>): string | null {
	const parts = [
		a.months?.length ? `${monthsText(a.months)} only` : '',
		a.maxRateM3s !== null && a.maxRateM3s !== undefined ? `at most ${fmtNum(a.maxRateM3s, 3, true)} m³/s` : '',
		a.conditions?.length ? `${a.conditions.length} condition${a.conditions.length === 1 ? '' : 's'}` : ''
	].filter(Boolean);
	return parts.length ? parts.join(' · ') : null;
}

/** The form's conditions box, one condition a line: trimmed, blank lines dropped. */
export const conditionsFromText = (text: string): string[] =>
	text
		.split(/\r?\n/)
		.map((c) => c.trim())
		.filter(Boolean);

/**
 * What a run's allocation mode (engine ≥ 1.18.0, Settings) did to its use,
 * said above the comparison; null for 'none', where the comparison is the
 * whole story.
 */
export const MODE_NOTE: Record<AllocationMode, string | null> = {
	none: null,
	cap: 'This run capped each unit’s use at its registered volume per water year (allocation mode “cap”), so its modelled use can’t be above it. A unit with no registered volume wasn’t capped.',
	fullAllocation:
		'This run is a full allocation: each unit with a registered volume had its demand scaled so it asks for exactly that volume every water year (a demand level or a Scale demand change then takes that share of it). It shows what the river would look like if every registered or licensed volume were taken in full (a registration is not an entitlement), not what the units take.'
};

/** "2021/22". */
export const waterYearLabel = (wy: number) => `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`;

/** One sentence for a year's comparison, with the tolerance, never a legal word. */
export function statusSentence(y: Pick<AllocationYear, 'status' | 'ratio' | 'modelledM3' | 'registeredM3'>, tolerance: number): string {
	const band = `±${fmtNum(tolerance * 100, 0)} %`;
	switch (y.status) {
		case 'over':
			return `Modelled use is ${fmtNum(((y.ratio ?? 0) - 1) * 100, 0)} % above the registered volume (outside the ${band} band).`;
		case 'under':
			return `Modelled use is ${fmtNum((1 - (y.ratio ?? 0)) * 100, 0)} % below the registered volume (outside the ${band} band).`;
		case 'within':
			return `Modelled use is within ${band} of the registered volume.`;
		case 'unregistered':
			return `The model abstracts ${fmtNum(y.modelledM3)} m³ here, with no registered volume in force.`;
		case 'none':
			return 'No modelled use and no registered volume.';
	}
}

/** A table row of the comparison: one farm, one water source, one water year. */
export interface ComparisonRow {
	key: string;
	nodeId: string;
	name: string;
	source: AllocationWaterSourceKind;
	year: AllocationYear;
}

/**
 * The comparison as table rows, farm by farm, surface before groundwater. A
 * source with neither use nor a registered volume in any year is left out
 * (most farms have no boreholes).
 */
export function comparisonRows(c: AllocationComparison): ComparisonRow[] {
	const out: ComparisonRow[] = [];
	for (const n of c.nodes)
		for (const side of [n.surface, n.groundwater]) {
			if (side.years.every((y) => y.status === 'none')) continue;
			for (const y of side.years) out.push({ key: `${n.nodeId}:${side.waterSource}:${y.waterYear}`, nodeId: n.nodeId, name: n.name, source: side.waterSource, year: y });
		}
	return out;
}

/** One unit and water source on the page's list: its whole water years at a glance. */
export interface UnitRow {
	key: string;
	nodeId: string;
	name: string;
	source: AllocationWaterSourceKind;
	/** Above registered when any whole year was; else the status of the mean year (or of the part year, without a whole one). */
	status: AllocationStatus;
	yearsOver: number;
	wholeYears: number;
	/** Mean registered volume and modelled use per whole water year, m³ (the part year's own when there is no whole year). */
	registeredM3: number;
	modelledM3: number;
	ratio: number | null;
	/** The run covers no whole water year of it: the figures are the part year's. */
	partOnly: boolean;
}

const STATUS_RANK: Record<AllocationStatus, number> = { over: 0, unregistered: 1, under: 2, within: 3, none: 4 };

/**
 * The comparison as one row per unit and source, the ones to look into
 * first: above registered (most years over, then the largest ratio), use
 * with no registered volume (the most use), below registered (the smallest
 * ratio), within the band, then neither; the run's order otherwise. Sources
 * with neither use nor a volume in any year are left out, as in
 * comparisonRows.
 */
export function unitRows(c: AllocationComparison): UnitRow[] {
	const out: (UnitRow & { i: number })[] = [];
	for (const n of c.nodes)
		for (const side of [n.surface, n.groundwater]) {
			if (side.years.every((y) => y.status === 'none')) continue;
			const partOnly = side.wholeYears === 0;
			const registeredM3 = partOnly ? side.years.reduce((a, y) => a + y.registeredM3, 0) : (side.meanRegisteredM3PerYear ?? 0);
			const modelledM3 = partOnly ? side.years.reduce((a, y) => a + y.modelledM3, 0) : (side.meanModelledM3PerYear ?? 0);
			out.push({
				key: `${n.nodeId}:${side.waterSource}`,
				nodeId: n.nodeId,
				name: n.name,
				source: side.waterSource,
				status: side.yearsOver > 0 ? 'over' : allocationStatus(modelledM3, registeredM3, c.tolerance),
				yearsOver: side.yearsOver,
				wholeYears: side.wholeYears,
				registeredM3,
				modelledM3,
				ratio: registeredM3 > 0 ? modelledM3 / registeredM3 : null,
				partOnly,
				i: out.length
			});
		}
	const within = (a: UnitRow, b: UnitRow) => {
		switch (a.status) {
			case 'over':
				return b.yearsOver - a.yearsOver || (b.ratio ?? 0) - (a.ratio ?? 0);
			case 'unregistered':
				return b.modelledM3 - a.modelledM3;
			case 'under':
				return (a.ratio ?? 0) - (b.ratio ?? 0);
			default:
				return 0;
		}
	};
	return out.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || within(a, b) || a.i - b.i).map(({ i: _, ...r }) => r);
}

/** The picked unit: `unit=` when it is on the list, else the first (the one to look into first); null with no rows. */
export function pickUnit(rows: readonly UnitRow[], param: string | null): string | null {
	return (param && rows.some((r) => r.nodeId === param) ? param : rows[0]?.nodeId) ?? null;
}

/**
 * The comparison rows in the list's order (the units to look into first),
 * each unit and source's water years together and in order, so the table's
 * first rows are the ones that matter. Rows for a unit not on the list keep
 * their place after it.
 */
export function rowsInListOrder(rows: readonly ComparisonRow[], units: readonly UnitRow[]): ComparisonRow[] {
	const rank = new Map(units.map((u, i) => [u.key, i]));
	const at = (r: ComparisonRow) => rank.get(`${r.nodeId}:${r.source}`) ?? units.length;
	return rows.map((r, i) => ({ r, i })).sort((a, b) => at(a.r) - at(b.r) || a.i - b.i).map(({ r }) => r);
}

/**
 * The picked unit's water years folded to the latest `cap` (both sources of
 * each), unless `open` or there is only one more to fold away. `years` is how
 * many water years there are in all.
 */
export function foldYears(rows: readonly ComparisonRow[], open: boolean, cap: number): { shown: ComparisonRow[]; years: number; folded: boolean } {
	const all = [...new Set(rows.map((r) => r.year.waterYear))].sort((a, b) => a - b);
	if (open || all.length <= cap + 1) return { shown: [...rows], years: all.length, folded: false };
	const keep = new Set(all.slice(-cap));
	return { shown: rows.filter((r) => keep.has(r.year.waterYear)), years: all.length, folded: true };
}

/** A row's status in words, with the years for "above registered": "Above registered in 2 of 3 whole years". */
export function unitStatusText(r: UnitRow): string {
	if (r.status === 'over' && r.wholeYears > 0) return `${STATUS_LABEL.over} in ${r.yearsOver} of ${r.wholeYears} whole year${r.wholeYears === 1 ? '' : 's'}`;
	return STATUS_LABEL[r.status];
}

/** The section header's line: "40 registered volumes · 4 not matched · 13 units above registered". */
export function allocationsContext(volumes: number, unmatched: number, rows: readonly UnitRow[] | null): string {
	const parts = [volumes ? `${fmtNum(volumes)} registered volume${volumes === 1 ? '' : 's'}` : 'No registered volumes yet'];
	if (unmatched) parts.push(`${fmtNum(unmatched)} not matched`);
	if (rows?.length) {
		const over = new Set(rows.filter((r) => r.status === 'over').map((r) => r.nodeId)).size;
		parts.push(over ? `${fmtNum(over)} hydrological unit${over === 1 ? '' : 's'} above registered` : 'no hydrological unit above registered');
	}
	return parts.join(' · ');
}

/**
 * A water source's total for a viewer (162, D3): "Surface water: 12 registered
 * users, 1 250 000 m³ a year registered today, 300 000 m³ of storage."
 */
export function totalsSentence(t: AllocationTotal): string {
	const storage = t.storageM3 !== null ? `, ${fmtNum(t.storageM3)} m³ of storage` : '';
	return `${SOURCE_LABEL[t.waterSource]}: ${fmtNum(t.holders)} registered users, ${fmtNum(t.registeredM3PerYear)} m³ a year registered today${storage}.`;
}

/** The note an owner reads before letting viewers see each farm's registered volumes (162, D3). */
export const VIEWER_UNITS_NOTE =
	'Only switch this on if every viewer of this catchment works for, or was appointed by, your organisation. Otherwise viewers see totals per water source, at 5 or more registered users.';

/** Preview rows in the order a person fixes them: rows with problems, then unmatched, then matched; file order within each. */
export function previewOrder(rows: readonly AllocationPreviewRow[]): AllocationPreviewRow[] {
	const rank = (r: AllocationPreviewRow) => (r.errors.length ? 0 : r.nodeId === null ? 1 : 2);
	return [...rows].sort((a, b) => rank(a) - rank(b) || a.line - b.line);
}

/** How a preview row was matched, in words. */
export const MATCHED_BY_LABEL: Record<NonNullable<AllocationPreviewRow['matchedBy']>, string> = {
	registration: 'same registration number as an earlier import',
	property: 'same property as an earlier import',
	name: 'farm name',
	manual: 'chosen by you'
};

/** The CSV template's header line (backend TEMPLATE_HEADERS) and one invented example row. */
export const TEMPLATE_CSV =
	'registration_no,property_ref,farm,holder,authorisation,purpose,water_source,volume_m3_year,storage_m3,valid_from,valid_to,reference,months,max_rate_m3s,conditions,water_use\r\n' +
	'EXAMPLE-001,Portion 1 of Example 1,Farm A,Example Holdings,licence,irrigation,surface,120000,150000,2020-01-01,2040-12-31,example row: replace,Oct-Mar,0.05,No abstraction below 0.2 m3/s at the weir | Meter and report monthly,21a\r\n';

/**
 * The import sheet's "Expected format" example (issue #456): the template's
 * fewest columns a row needs, a take and a dam's storage. Invented values;
 * the e2e spec imports it (upload-formats.spec.ts).
 */
export const ALLOCATIONS_EXAMPLE =
	'registration_no,farm,authorisation,water_source,volume_m3_year,water_use\n' +
	'EXAMPLE-001,Farm A,licence,surface,120000,21a\n' +
	'EXAMPLE-002,Farm A,licence,surface,150000,21b';


/** The import sheet's Expected format (issue #456; the File formats help page, issue #477). */
export const ALLOCATIONS_FORMAT: FileFormat = {
	id: 'registered-volumes',
	title: 'Registered water-use volumes (WARMS, licences)',
	where: 'Allocations → Import',
	accepts: 'A CSV file (.csv), comma- or semicolon-separated, in UTF-8: at most 2 MB, 5 000 rows and 200 columns. An Excel workbook isn’t read: save the sheet as CSV first.',
	rules: [
		'The first row holds the headings, in any order: the template’s (`registration_no`, `farm`, `volume_m3_year` …) or a WARMS extract’s (“Registration Number”, “Registered Volume (m3/a)”, “Water Use Sector” …). A column it doesn’t know is listed as not read.',
		'Every file needs a volume column. A WARMS extract also needs a water-use column (21(a) taking, 21(b) storing); in the template a blank is a take.',
		'Each row needs a registration number, property or farm to match it by; its volume in m³ a year (a 21(b) row: the dam’s storage in m³); and its water source, surface or groundwater (a 21(b) row is surface). The template’s rows need their authorisation too (registration, licence, general authorisation, Schedule 1, existing lawful use); a WARMS extract without that column is read as registrations.',
		'Units: m³ a year, unless a Unit column says otherwise (m3/a, Ml/a, kl/a; a megalitre is 1 000 m³). A volume per month or day is refused.',
		'Numbers: in a comma-separated file a point is the decimal mark (1500.5, 1,500); in a semicolon-separated file a comma (1500,5, 1.500).',
		'Dates as YYYY-MM-DD (or YYYY/MM/DD); months as `Oct-Mar` or `10 11 12 1 2 3`; licence conditions separated by |.',
		'A column headed ID number, passport, phone, cell, fax or email refuses the whole file: delete it first.',
		'The preview lists every row with its line number; a row with a problem says what it is and isn’t imported.'
	],
	example: ALLOCATIONS_EXAMPLE,
	files: [
		{ name: 'allocations-example.csv', text: `${ALLOCATIONS_EXAMPLE}\r\n`, label: 'Download an example file' },
		{ name: 'allocations-full-template.csv', text: TEMPLATE_CSV, label: 'Download the full template, every column' }
	]
};

/** The first 12 hex digits of a SHA-256, for display beside the full hash in a title. */
export const shortHash = (sha: string) => sha.slice(0, 12);

/** "2003/04", "2003/04 and 2005/06", "2003/04, 2004/05 and 2005/06". */
const yearList = (ys: readonly number[]) => {
	const l = ys.map(waterYearLabel);
	return l.length < 2 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`;
};

/**
 * A cap run's water years for one unit and source in words (engine ≥ 1.18.0,
 * docs/allocations.md § The cap): the days the licence limit held use back,
 * by which limit (engine ≥ 1.40.0), then the years the registered volume was
 * used up. A run before 1.40.0 says only the years. Modelled, not a finding.
 * The counts come from the run's summary, which covers a forecast tail too
 * (`forecast`), unlike the comparison, so that is said.
 */
export function capYearsText(c: AllocationCapYears, forecast = false): string {
	const text = capYearsWords(c);
	return forecast ? `${text} These counts include the run’s forecast days, which the comparison above leaves out.` : text;
}

function capYearsWords(c: AllocationCapYears): string {
	const reached = c.capReached.map((y) => y.waterYear);
	const usedUp = reached.length ? `The registered volume was used up in ${yearList(reached)}.` : 'The registered volume was never used up.';
	if (!c.limitBound) return `${usedUp} (This run is from before the app counted the days the licence held use back; run the model again to see them.)`;
	const sum = (k: 'days' | 'volumeDays' | 'rateDays' | 'monthsDays') => c.limitBound!.reduce((a, y) => a + y[k], 0);
	const days = sum('days');
	if (!days) return `The cap never held use back. ${usedUp}`;
	const years = c.limitBound.filter((y) => y.days > 0).length;
	const parts = [
		[sum('volumeDays'), 'with the volume used up'],
		[sum('rateDays'), 'at the maximum rate'],
		[sum('monthsDays'), 'outside the months of use']
	]
		.filter(([n]) => (n as number) > 0)
		.map(([n, w]) => `${fmtNum(n as number)} ${w}`);
	return `The cap held use back on ${fmtNum(days)} day${days === 1 ? '' : 's'} in ${years} water year${years === 1 ? '' : 's'}: ${parts.join(', ')}. ${usedUp}`;
}
