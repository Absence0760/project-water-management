// A unit's CHIRPS feed (config.unit, feeds/fromUnits.ts, issue #482) writes
// that land unit's own rain: the series it creates is sited at the unit
// (209_unit_rain_series' time_series_site_from_feed). The ingest asks this
// first, so a feed whose unit has left the model, or is no longer a land unit,
// fails with words of its own (data_feed.last_error, which the feed panel
// shows) instead of writing rain no unit is there to take, or meeting the
// database's site check. Pure SQL under the acting user's RLS; no route
// imports, so the worker Lambda can reach it.
import type { Db } from '../db/tx.js';
import type { FeedRow } from './store.js';
import type { GridConfig } from './config.js';

/** Why a unit feed can't write now, or null (also for any other feed). */
export async function unitFeedProblem(db: Db, feed: Pick<FeedRow, 'projectId' | 'source' | 'config'>): Promise<string | null> {
	const unit = feed.source === 'chirps' ? (feed.config as GridConfig).unit : undefined;
	if (!unit) return null;
	const { rows } = await db.query<{ kind: string }>('SELECT kind::text AS kind FROM node WHERE project_id = $1 AND id = $2', [feed.projectId, unit.nodeId]);
	if (rows[0]?.kind === 'farm') return null;
	return rows[0]
		? 'this feed’s unit is no longer a land unit of the model, so nothing was written: remove the feed, or set the unit’s rain up again (Rain for each unit)'
		: 'this feed’s unit is no longer in the model, so nothing was written: remove the feed, or set the unit’s rain up again (Rain for each unit)';
}
