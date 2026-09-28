// Alert emails in the workspace (WP-2.13, docs/ui.md § Alerts): the words of
// Overview → Active alerts and the rule editor, in English like the rest of
// the workspace. No message catalogue here: the workspace never loads it
// (lib/i18n/boundary.test.ts). The farmer-facing pages' words are in
// ./words.ts. Pure, so it is unit-tested apart from the pages.
import type { AlertEvent, AlertKind, AlertRule } from '$lib/api/types';
import { fmtDay, fmtNum } from '$lib/format/number';

export const KIND_NAME: Record<AlertKind, string> = {
	dam_below: 'Dam low',
	ewr_forecast_fail: 'EWR at risk in the forecast',
	data_stale: 'Data feed behind',
	restriction_published: 'Restriction notice',
	job_dead: 'Background jobs failed',
	feed_failing: 'Data feed failing'
};

const pct = (f: unknown) => (typeof f === 'number' && Number.isFinite(f) ? `${fmtNum(Math.round(f * 100))} %` : '–');
const day = (d: unknown) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? fmtDay(d.slice(0, 10)) : '');
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One firing alert, in a sentence: "Farm One: dam about 8 % on 20 Sep 2026 (alert below 30 %)". */
export function eventText(e: AlertEvent): string {
	const d = e.detail;
	switch (e.kind) {
		case 'dam_below':
			return d.source === 'forecast'
				? `${e.nodeName ?? 'A hydrological unit'}: dam may fall to about ${pct(d.pct)} around ${day(d.date)} on the forecast (alert below ${pct(e.threshold)})`
				: `${e.nodeName ?? 'A hydrological unit'}: dam about ${pct(d.pct)} on ${day(d.date)} (alert below ${pct(e.threshold)})`;
		case 'ewr_forecast_fail':
			return `EWR at the outlet at risk on ${n(d.days)} of ${n(d.of)} forecast days (alert at ${e.threshold})`;
		case 'data_stale': {
			const feeds = Array.isArray(d.feeds) ? (d.feeds as { label: string; overdue: number }[]) : [];
			return feeds.length ? `Late: ${feeds.map((f) => `${f.label} (${f.overdue} days)`).join(', ')}` : 'A data feed is behind';
		}
		case 'feed_failing': {
			const feeds = Array.isArray(d.feeds) ? (d.feeds as { label: string; failures: number }[]) : [];
			return feeds.length ? `Failing: ${feeds.map((f) => `${f.label} (${f.failures} in a row)`).join(', ')}` : 'A data feed is failing';
		}
		case 'job_dead':
			return `${n(d.count)} background ${n(d.count) === 1 ? 'job' : 'jobs'} failed in the last 24 hours`;
		case 'restriction_published':
			return `Restriction in place: ${String(d.level ?? '')}${typeof d.pct === 'number' ? `, ${fmtNum(d.pct)} %` : ''}`;
	}
}

/** How a rule's threshold is typed in the editor: a dam level in percent, everything else as stored. */
export function thresholdToInput(kind: AlertKind, threshold: number): number {
	return kind === 'dam_below' ? Math.round(threshold * 1000) / 10 : threshold;
}

export function thresholdFromInput(kind: AlertKind, value: number): number {
	return kind === 'dam_below' ? value / 100 : value;
}

/** What the threshold means, for its label; null for a kind without one. */
export function thresholdLabel(kind: AlertKind): string | null {
	switch (kind) {
		case 'dam_below':
			return 'Alert below (% of dam capacity)';
		case 'ewr_forecast_fail':
			return 'Alert at (forecast days at risk)';
		case 'data_stale':
			return 'Alert after (days later than usual for this feed)';
		case 'feed_failing':
			return 'Alert after (failures in a row)';
		case 'job_dead':
			return 'Alert at (dead jobs in 24 hours)';
		case 'restriction_published':
			return null;
	}
}

/** The editor's limits per kind (the API's THRESHOLD, in the editor's units). */
export const THRESHOLD_INPUT: Record<AlertKind, { min: number; max: number; step: number }> = {
	dam_below: { min: 1, max: 99, step: 1 },
	ewr_forecast_fail: { min: 1, max: 60, step: 1 },
	data_stale: { min: 1, max: 60, step: 1 },
	feed_failing: { min: 1, max: 20, step: 1 },
	job_dead: { min: 1, max: 100, step: 1 },
	restriction_published: { min: 0, max: 0, step: 1 }
};

/** Whether a typed threshold is within its kind's range; null when fine, else why not. */
export function thresholdProblem(kind: AlertKind, value: number): string | null {
	if (kind === 'restriction_published') return null;
	const r = THRESHOLD_INPUT[kind];
	if (!Number.isFinite(value)) return 'Enter a number.';
	if (kind !== 'dam_below' && !Number.isInteger(value)) return 'Enter a whole number.';
	if (value < r.min || value > r.max) return `Between ${r.min} and ${r.max}.`;
	return null;
}

/**
 * The project-wide rules first (in the API's order), then the farms' dam
 * rules, then the data feeds' staleness rules (one per feed, each with its
 * own level); and whether any is on.
 */
export function groupRules<R extends AlertRule>(rules: R[]): { catchment: R[]; farms: R[]; feeds: R[]; anyOn: boolean } {
	return {
		catchment: rules.filter((r) => r.kind !== 'dam_below' && r.kind !== 'data_stale'),
		farms: rules.filter((r) => r.kind === 'dam_below'),
		feeds: rules.filter((r) => r.kind === 'data_stale'),
		anyOn: rules.some((r) => r.enabled)
	};
}

/** A data feed's staleness rule, as the editor labels it: the feed, and "(switched off)" for a disabled feed. */
export const feedRuleLabel = (r: Pick<AlertRule, 'feedName' | 'feedEnabled'>) => `${r.feedName ?? 'Data feed'}${r.feedEnabled === false ? ' (feed switched off)' : ''}`;
