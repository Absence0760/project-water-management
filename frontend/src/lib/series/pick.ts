// Which of several series of one kind a run reads (issue #523): the first by
// name in the byte order of the name (engine compareSeriesNames), as the
// backend's loadLiveInput picks with `ORDER BY … name COLLATE "C"`. Never
// localeCompare: a linguistic order puts "average gauge" before "RAIN-B
// logger", byte order after, so the Data tab would mark one series in use
// while runs read the other. Nor the API list's order, which the database's
// collation sorts.
import { compareSeriesNames, type SeriesMeta } from '@water-management/engine';

type Named = Pick<SeriesMeta, 'kind' | 'name'> & { siteNodeId?: string | null };

/** Series sorted by kind, then by name as a run picks (engine compareSeriesNames). A copy. */
export function byKindThenName<T extends Named>(list: readonly T[]): T[] {
	return [...list].sort((a, b) => compareSeriesNames(a.kind, b.kind) || compareSeriesNames(a.name, b.name));
}

/** The outlet's series of `kind` a run reads: the first by name among those with no site (a gauge's record or a unit's own rain is never the outlet's). */
export function firstOutletSeries<T extends Named>(list: readonly T[], kind: string): T | undefined {
	let first: T | undefined;
	for (const s of list) if (s.kind === kind && !s.siteNodeId && (!first || compareSeriesNames(s.name, first.name) < 0)) first = s;
	return first;
}

