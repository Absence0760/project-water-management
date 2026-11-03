// A data feed writing a series no run reads (issue #670). A run reads the
// first series of each kind by name (roles.ts seriesInUse, the backend's
// loadLiveInput), so a feed can keep filling one series while runs read
// another of the same kind, and when the one runs read has no feed it stops
// at its last day: new days never reach a run, and nothing said so (the Data
// row only read "Not used (another series of this kind is)"). This finds
// those pairs for Run readiness (runs/RunsTab.svelte) and the Data rows'
// role badges (roles.ts roleBadge), so both name the two series and the fix.
//
// The fix is the existing one, never a new choice: runs keep reading the
// first by name, so rename or remove the series runs read (a feed's own
// series keeps its name, the feed writes by it), or, for CHIRPS, replace it
// from Rain from the boundary (docs/maps.md § Rain from the boundary).
import type { NetworkNode, ProjectSettings, SeriesMeta } from '@water-management/engine';
import { fmtDay } from '#lib/format/number.js';
import { kindLabel } from '#lib/series/kinds.js';
import { dataEnd } from './freshness';
import { stationRead, stationUses } from './groups';
import { seriesInUse } from './roles';

export interface FeedShadow {
	/** The series a data feed writes, which no run reads. */
	fed: SeriesMeta;
	/** The series of the same kind runs read in its place. */
	read: SeriesMeta;
	/**
	 * No feed writes `read` and its data ends before `fed`'s: the days the feed
	 * keeps adding never reach a run.
	 */
	stalled: boolean;
}

/** A feed wrote days of the series that are still its own (031_feed_days; null for a reader who can't see the feeds). */
const fedByFeed = (s: SeriesMeta) => !!s.feed && s.feed.days > 0;

/**
 * The series a data feed writes that no run reads because another series of
 * the same kind is read instead, outlet series only (a unit's own rain and a
 * gauge's record are read at their site). Catchment rain follows the station
 * rules (roles.ts roleBadge): a station assigned to an area is read, and with
 * a station for the catchment that station is the series read. A kind whose
 * series no run reads at all (a reference gauge, a logger beside an observed
 * gauge, a kind no rain-source period names) has nothing read in its place,
 * so it is not listed. Stalled pairs first, then by kind and name.
 */
export function feedShadows(
	list: readonly SeriesMeta[],
	ctx: { periodKinds?: ReadonlySet<string>; settings?: ProjectSettings | null; nodes?: readonly NetworkNode[] } = {}
): FeedShadow[] {
	const inUse = seriesInUse([...list], ctx.periodKinds);
	const cs = ctx.settings?.rainStations?.catchment?.stationId ?? null;
	const catchmentStation = cs ? list.find((x) => x.id === cs && !x.siteNodeId && x.kind === 'rain_catchment_mm') : undefined;
	const readOf = (kind: string) =>
		kind === 'rain_catchment_mm' && catchmentStation ? catchmentStation : list.find((x) => x.kind === kind && !x.siteNodeId && inUse.has(x.id));
	const out: FeedShadow[] = [];
	for (const s of list) {
		if (s.siteNodeId || !fedByFeed(s)) continue;
		const read = readOf(s.kind);
		if (!read || read.id === s.id) continue;
		if (s.kind === 'rain_catchment_mm' && stationRead(stationUses(s.id, ctx.settings, ctx.nodes ?? []))) continue;
		out.push({ fed: s, read, stalled: !fedByFeed(read) && dataEnd(read) < dataEnd(s) });
	}
	return out.sort((a, b) => Number(b.stalled) - Number(a.stalled) || a.fed.kind.localeCompare(b.fed.kind) || a.fed.name.localeCompare(b.fed.name));
}

const named = (s: SeriesMeta) => `“${s.name || kindLabel(s.kind)}”`;
const span = (s: SeriesMeta) => `${fmtDay(s.startDate)} to ${fmtDay(dataEnd(s))}`;

/**
 * Run readiness's sentence for one pair: which series runs read for the kind,
 * which one the feed writes, and for a stalled pair that the feed's newer days
 * never reach a run. The fix (rename or remove the series read, or replace it
 * from the boundary) is the links after it.
 */
export function feedShadowText(x: FeedShadow): string {
	const kind = kindLabel(x.read.kind);
	if (x.stalled) {
		return `Runs read ${named(x.read)} (${span(x.read)}) for ${kind}, which no data feed writes, so it gets no new days; a data feed writes ${named(x.fed)} (${span(x.fed)}), but a run reads only the first series of a kind by name, so the feed’s days after ${fmtDay(dataEnd(x.read))} never reach a run.`;
	}
	return `A data feed writes ${named(x.fed)} (${span(x.fed)}), but runs read ${named(x.read)} (${span(x.read)}) for ${kind}: a run reads only the first series of a kind by name.`;
}

/** Whether Rain from the boundary can be offered as the fix: a stalled CHIRPS record no feed writes (its Replace points a feed at it, maps.md). */
export const boundaryFixes = (x: FeedShadow) => x.stalled && x.read.kind === 'rain_chirps_mm';

/**
 * The Data row's words under its role badge (roles.ts roleBadge `why`): on the
 * feed's series, that runs read the other; on a stalled series runs read, that
 * no feed writes it while the feed's series runs on. Null when the series is
 * in no pair.
 */
export function feedShadowWhy(s: SeriesMeta, shadows: readonly FeedShadow[]): string | null {
	const asFed = shadows.find((x) => x.fed.id === s.id);
	if (asFed) {
		return asFed.stalled
			? `A data feed writes this series, but runs read ${named(asFed.read)}, the first of its kind by name, which no feed writes and which ends ${fmtDay(dataEnd(asFed.read))}: this series’ newer days never reach a run. Rename or remove ${named(asFed.read)} so runs read this one.`
			: `A data feed writes this series, but runs read ${named(asFed.read)}, the first of its kind by name.`;
	}
	const asRead = shadows.find((x) => x.read.id === s.id && x.stalled);
	if (asRead) return `No data feed writes this series, so it ends ${fmtDay(dataEnd(s))}, while ${named(asRead.fed)}, which a feed writes, runs to ${fmtDay(dataEnd(asRead.fed))}. Runs read this one, the first of its kind by name.`;
	return null;
}
