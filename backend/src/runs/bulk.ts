// Paging for GET /projects/:id/runs/:runId/series/bulk (docs/api.md § Export):
// every series of one node in one response, cut into day windows small
// enough to stay under MAX_JSON_EXPORT_BYTES: a page is built in memory and the
// browser holds it whole, so it stays a page even though the API's responses
// stream since WP-1.29a. Pure; unit-tested in bulk.test.ts.
import type { DailyScope } from '../export/daily-columns.js';
import { MAX_JSON_EXPORT_BYTES } from '../export/csv.js';

/**
 * Longest JSON text of one value plus its comma. A double is at most 24
 * characters (`-2.2250738585072014e-308`), `null` 4, so 25 is a hard upper
 * bound: a page sized with it can't pass the cap whatever the values are.
 */
export const MAX_VALUE_BYTES = 25;

/** Room kept for the envelope and each series' key, label, unit and header. */
export const BULK_OVERHEAD_BYTES = 256 * 1024;

/** Values one page may carry (≈ 199 000 with the 5 MB cap). */
export const BULK_PAGE_VALUES = Math.floor((MAX_JSON_EXPORT_BYTES - BULK_OVERHEAD_BYTES) / MAX_VALUE_BYTES);

/** Days per page for a scope with `seriesCount` series (at least 1). */
export function bulkPageDays(seriesCount: number): number {
	return Math.max(1, Math.floor(BULK_PAGE_VALUES / Math.max(1, seriesCount)));
}

export interface BulkPage {
	nodeId: string | null;
	name: string;
	kind: DailyScope['kind'];
	/** The run's first day and length: the longest series. */
	startDate: string;
	days: number;
	/** This page: days offset … offset + count − 1 (0-based, from startDate). */
	offset: number;
	count: number;
	/** The offset of the next page, null on the last. */
	next: number | null;
	series: { key: string; label: string; unit: string | null; header: string; values: (number | null)[] }[];
}

/** The page of `scope` starting at day `offset`; null when offset is past the run. */
export function bulkPage(scope: DailyScope, nodeId: string | null, startDate: string, offset: number): BulkPage | null {
	const days = Math.max(0, ...scope.series.map((s) => s.values.length));
	if (offset >= days) return null;
	const count = Math.min(bulkPageDays(scope.series.length), days - offset);
	const end = offset + count;
	return {
		nodeId,
		name: scope.name,
		kind: scope.kind,
		startDate,
		days,
		offset,
		count,
		next: end < days ? end : null,
		series: scope.series.map((s) => ({
			key: s.key,
			label: s.label,
			unit: s.unit,
			header: s.header,
			// A shorter series (none today) pads with null so every column has `count` values.
			values: Array.from({ length: count }, (_, i) => s.values[offset + i] ?? null)
		}))
	};
}
