// What the Warnings page and the Data row's badge read (issue #611): every
// checked series' values, through the Data tab's own per-session cache
// (series/valuesCache.ts), and the shown run's summary through Runs' cache
// (runs/cache.ts). One loader, so the badge and the page count from the same
// inputs and the same helper (items.ts warningItems): a badge that disagreed
// with the page's Open chip would be a bug (ui-playbook.md § 3 "Honest numbers").
import { SERIES_KINDS, type ProjectSettings, type RunSummary, type SeriesMeta } from '@water-management/engine';
import { api } from '#lib/api/index.js';
import { runDetail } from '#lib/components/runs/cache.js';
import { cachedValues, cacheValues } from '#lib/components/series/valuesCache.js';
import type { Daily } from '#lib/components/series/coverage.js';
import { openCount, warningItems } from './items';
import { feedsApi, healthMessage } from '#lib/components/feeds/feeds.js';
import { kindLabel } from '#lib/series/kinds.js';
import type { FeedProblem } from './problems';

/** The series the checks read: the checked kinds (SERIES_KINDS), as the Data tab's checks. */
export const checkedSeries = (series: readonly SeriesMeta[]): SeriesMeta[] => series.filter((s) => (SERIES_KINDS as readonly string[]).includes(s.kind));

/** Each checked series' values (cached ones at once), and the ones that couldn't be read, with why. */
export async function loadValues(projectId: string, series: readonly SeriesMeta[]): Promise<{ values: Record<string, Daily>; failed: Record<string, string> }> {
	const values: Record<string, Daily> = {};
	const failed: Record<string, string> = {};
	await Promise.all(
		checkedSeries(series).map(async (s) => {
			const hit = cachedValues(projectId, s);
			if (hit) {
				values[s.id] = hit;
				return;
			}
			try {
				values[s.id] = cacheValues(projectId, await api.series.get(projectId, s.id));
			} catch (e) {
				failed[s.id] = e instanceof Error ? e.message : String(e);
			}
		})
	);
	return { values, failed };
}

/** A run's summary through Runs' cache; null without a run id. */
export async function loadRunSummary(projectId: string, runId: string | null): Promise<RunSummary | null> {
	if (!runId) return null;
	const d = await runDetail(runId, () => api.runs.get(projectId, runId));
	return d.run.summary;
}

/** The open items' count for the Data row's badge (null when a read failed: no badge rather than a wrong one). */
export async function openWarningCount(
	projectId: string,
	series: readonly SeriesMeta[],
	settings: ProjectSettings,
	runId: string | null,
	nodeName: (id: string) => string | null | undefined
): Promise<number | null> {
	const [{ values, failed }, run] = await Promise.all([loadValues(projectId, series), loadRunSummary(projectId, runId).catch(() => undefined)]);
	if (Object.keys(failed).length || run === undefined) return null;
	return openCount(warningItems({ series, values, settings, run, nodeName }));
}

/**
 * The project's data feeds that need attention (failing or stale, as the Data page's Data feeds health says, feeds.ts
 * needsAttention), each named by its source and the series it fills, with its health sentence.
 */
export async function loadFeedProblems(projectId: string): Promise<FeedProblem[]> {
	const list = await feedsApi(api, projectId).list();
	const label = new Map(list.sources.map((o) => [o.source, o.label]));
	return list.feeds
		.filter((f) => f.health.state === 'failing' || f.health.state === 'stale')
		.map((f) => ({ id: f.id, name: `${label.get(f.source) ?? f.source} into ${f.targetName || kindLabel(f.targetKind)}`, message: healthMessage(f.health), enabled: f.enabled }));
}
