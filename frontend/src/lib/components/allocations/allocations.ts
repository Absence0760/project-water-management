// Words and table shapes for the Allocations tab (WP-3.10, docs/ui.md
// § Allocations). Pure, unit-tested in allocations.test.ts.
//
// The wording never says "lawful", "unlawful", "compliant" or "illegal": the
// app compares modelled use with a registered volume and leaves the finding to
// the authority (docs/allocations.md § What the comparison is not).
import type { AllocationComparison, AllocationStatus, AllocationYear } from '@water-management/engine';
import type { AllocationAuthorisation, AllocationPreviewRow, AllocationPurpose, AllocationWaterSourceKind } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';

export const AUTHORISATION_LABEL: Record<AllocationAuthorisation, string> = {
	registration: 'Registration (WARMS)',
	licence: 'Licence',
	general_authorisation: 'General authorisation',
	existing_lawful_use: 'Existing lawful use (verified)'
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

/** Short badge text per status: what the numbers say, not a finding. */
export const STATUS_LABEL: Record<AllocationStatus, string> = {
	over: 'Above registered',
	within: 'Within band',
	under: 'Below registered',
	unregistered: 'No registered volume',
	none: 'No use, none registered'
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

/** Per farm and source: how many whole water years were above the registered volume, for the headline. */
export function overSummary(c: AllocationComparison): { name: string; source: AllocationWaterSourceKind; yearsOver: number; wholeYears: number }[] {
	return c.nodes.flatMap((n) =>
		[n.surface, n.groundwater]
			.filter((s) => s.yearsOver > 0)
			.map((s) => ({ name: n.name, source: s.waterSource, yearsOver: s.yearsOver, wholeYears: s.wholeYears }))
	);
}

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
	'registration_no,property_ref,farm,holder,authorisation,purpose,water_source,volume_m3_year,storage_m3,valid_from,valid_to,reference\r\n' +
	'EXAMPLE-001,Portion 1 of Example 1,Farm A,Example Holdings,licence,irrigation,surface,120000,150000,2020-01-01,2040-12-31,example row: replace\r\n';

/** The first 12 hex digits of a SHA-256, for display beside the full hash in a title. */
export const shortHash = (sha: string) => sha.slice(0, 12);
