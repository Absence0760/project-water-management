// A project's data feeds (docs/api.md § Data feeds): list with health
// (viewer), attach / change / remove (owner), and "Run now" (editor), which
// queues a fetch at once instead of waiting for the schedule.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { readJson } from '../http/body.js';
import { feedFetchDedupeKey } from '../jobs/handlers/feed-fetch.js';
import { enqueueJob } from '../jobs/queue.js';
import { wakeWorker } from '../jobs/wake.js';
import { recordAudit } from '../history/record.js';
import { requireRole, UUID } from '../projects/access.js';
import { provenanceLabel, sameProvenance } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import {
	CHIRPS_DAILY_PRODUCTS,
	CHIRPS_PRODUCT_FIRST_DAY,
	chirpsProduct,
	FEED_SCHEDULES,
	FEED_SOURCES,
	FeedInput,
	FeedPatch,
	feedProvenance,
	type GridConfig,
	SOURCES
} from './config.js';
import { feedSourceMode } from './http.js';
import { createFeed, deleteFeed, getFeed, listFeeds, replaceKey, seriesAccepts, targetSeries, updateFeed } from './store.js';

/** At most this many feeds per project. */
export const MAX_FEEDS = 20;

const feedId = (id: string) => {
	if (!UUID.test(id)) throw new ApiError(404, 'not found');
	return id;
};

/** A second feed for one series (the unique constraint), as a clear 409. */
const conflict = (err: unknown): never => {
	if ((err as { code?: string }).code === '23505') throw new ApiError(409, 'another feed already writes that series');
	throw err;
};

/**
 * The version check when a feed is attached, re-targeted or given another
 * product (issue #40 part c): a target that holds values of another product
 * or version than the feed writes, or an unrecorded one, is refused (409)
 * unless the owner confirms replacing it (`replaceSeries: true`). The
 * confirmation is returned as the key of what the series holds now; the
 * ingest replaces the series whole only while it still holds exactly that.
 *
 * A replacement is a **full backfill**, never a shorter record: the feed
 * reads from the series' first day. Without a start date the feed gets that
 * one; a later start date is refused, and so is the `sat` product for a
 * series reaching before 1998, which only `rnl` covers (one product end to
 * end). `input` comes back with the start date filled in.
 *
 * `replaceFrom` undefined: nothing to confirm (or, for a save that doesn't
 * change what the feed writes where, nothing asked).
 */
async function versionCheck(db: Db, projectId: string, input: FeedInput, changed: boolean): Promise<{ input: FeedInput; replaceFrom?: string }> {
	const writes = feedProvenance(input.source, input.config);
	if (!writes) return { input };
	const series = await targetSeries(db, projectId, input.targetKind, input.targetName);
	if (seriesAccepts(writes, series)) return { input };
	if (input.replaceSeries) {
		const config = input.config as GridConfig;
		const product = chirpsProduct(config);
		const first = CHIRPS_PRODUCT_FIRST_DAY[product];
		const from = series!.firstDay!;
		if (from < first && product === 'sat') {
			throw new ApiError(
				409,
				`the series starts on ${from}, before CHIRPS v3’s sat product begins (${first}): a replacement backfills the whole record from one product, so use the rnl product (from ${CHIRPS_PRODUCT_FIRST_DAY.rnl})`,
				{ code: 'series_backfill', firstDay: from }
			);
		}
		const need = from < first ? first : from;
		if (config.startDate !== undefined && config.startDate > need) {
			throw new ApiError(
				409,
				`a replacement backfills the whole record: the series starts on ${from}, so the feed’s start date must be ${need} or earlier (or left empty)`,
				{ code: 'series_backfill', firstDay: from }
			);
		}
		const startDate = config.startDate ?? need;
		return { input: { ...input, config: { ...config, startDate } }, replaceFrom: replaceKey(series!) };
	}
	if (!changed) return { input };
	throw new ApiError(
		409,
		`the series holds ${provenanceLabel(series!.provenance)} rainfall and this feed writes ${provenanceLabel(writes)}: merging them would splice two versions into one record. Confirm replacing the series (its values are kept in the history), or point the feed at another series`,
		{ code: 'series_version', holds: series!.provenance, writes }
	);
}

/** A feed's configuration as the history records it (never its credentials: feeds carry none). */
const feedSubject = (
	feedId: string,
	action: 'created' | 'changed' | 'removed',
	f: { source: string; targetKind: string; targetName: string; schedule: string; enabled: boolean }
) => ({ feedId, action, source: f.source, targetKind: f.targetKind, targetName: f.targetName, schedule: f.schedule, enabled: f.enabled });

export const feedRoutes = new Hono<AuthEnv>()
	.get('/:id/feeds', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, c.req.param('id'), 'viewer');
			return c.json({
				feeds: await listFeeds(db, c.req.param('id')),
				// What the form offers, and whether this server fetches for real.
				sources: FEED_SOURCES.map((s) => ({ source: s, label: SOURCES[s].label, kinds: SOURCES[s].kinds, unit: SOURCES[s].unit })),
				// CHIRPS v3's daily products; the default (sat) first.
				chirpsProducts: CHIRPS_DAILY_PRODUCTS,
				schedules: FEED_SCHEDULES,
				mode: feedSourceMode(),
				canEdit: role === 'owner',
				canRun: role !== 'viewer'
			});
		})
	)
	.post('/:id/feeds', async (c) => {
		const input = FeedInput.parse(await readJson(c));
		const id = c.req.param('id');
		const feed = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			// Count and insert one attach at a time per project, so concurrent attaches can't pass the cap together.
			await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('data_feed_cap:' || $1::text, 0))`, [id]);
			const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM data_feed WHERE project_id = $1', [id]);
			if (rows[0]!.n >= MAX_FEEDS) throw new ApiError(409, `a project can have at most ${MAX_FEEDS} feeds`);
			const { input: checked, replaceFrom } = await versionCheck(db, id, input, true);
			const fid = await createFeed(db, id, checked, replaceFrom ?? null).catch(conflict);
			const feed = await getFeed(db, id, fid);
			await recordAudit(db, id, 'feed.configured', { ...feedSubject(fid, 'created', input), ...(replaceFrom !== undefined ? { replaceSeries: replaceFrom } : {}) });
			return feed;
		});
		return c.json({ feed }, 201);
	})
	// Change some of a feed's settings; the rest keep their values. Saving
	// makes the saver the feed's acting user.
	.patch('/:id/feeds/:feedId', async (c) => {
		const patch = FeedPatch.parse(await readJson(c));
		const id = c.req.param('id');
		const fid = feedId(c.req.param('feedId'));
		const feed = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const cur = await getFeed(db, id, fid);
			if (!cur) throw new ApiError(404, 'not found');
			const sourceChanged = patch.source !== undefined && patch.source !== cur.source;
			const input = FeedInput.parse({
				source: patch.source ?? cur.source,
				// A new source needs its own config and target.
				config: patch.config ?? (sourceChanged ? undefined : cur.config),
				targetKind: patch.targetKind ?? (sourceChanged ? undefined : cur.targetKind),
				targetName: patch.targetName ?? cur.targetName,
				schedule: patch.schedule ?? cur.schedule,
				enabled: patch.enabled ?? cur.enabled,
				replaceSeries: patch.replaceSeries ?? false
			});
			// Asked when the save changes where the feed writes or what it writes (source, product, target).
			const changed =
				input.source !== cur.source ||
				input.targetKind !== cur.targetKind ||
				input.targetName !== cur.targetName ||
				!sameProvenance(feedProvenance(input.source, input.config), cur.writes);
			const { input: checked, replaceFrom } = await versionCheck(db, id, input, changed);
			// replaceSeries: false withdraws a pending replacement (the trigger discards its stage); absent keeps it.
			const replace = patch.replaceSeries === false ? null : replaceFrom;
			if (!(await updateFeed(db, id, fid, checked, replace).catch(conflict))) throw new ApiError(404, 'not found');
			// Logged even when the settings come back unchanged: every save makes the saver the
			// feed's acting user (the identity its scheduled fetches run as), which is itself a change.
			await recordAudit(db, id, 'feed.configured', { ...feedSubject(fid, 'changed', input), ...(replaceFrom !== undefined ? { replaceSeries: replaceFrom } : {}) });
			return getFeed(db, id, fid);
		});
		return c.json({ feed });
	})
	.delete('/:id/feeds/:feedId', async (c) => {
		const id = c.req.param('id');
		const fid = feedId(c.req.param('feedId'));
		await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'owner');
			const cur = await getFeed(db, id, fid);
			if (!cur || !(await deleteFeed(db, id, fid))) throw new ApiError(404, 'not found');
			await recordAudit(db, id, 'feed.configured', feedSubject(fid, 'removed', cur));
		});
		return c.body(null, 204);
	})
	// Fetch now. One pending fetch per feed: a second press while one waits
	// returns that one (200) instead of queueing another.
	.post('/:id/feeds/:feedId/run-now', async (c) => {
		const id = c.req.param('id');
		const fid = feedId(c.req.param('feedId'));
		const result = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const feed = await getFeed(db, id, fid);
			if (!feed) throw new ApiError(404, 'not found');
			if (!feed.enabled) throw new ApiError(409, 'the feed is switched off');
			const r = await enqueueJob(db, { projectId: id, kind: 'feed_fetch', payload: { feedId: fid }, dedupeKey: feedFetchDedupeKey(fid) });
			// A fetch already pending may be waiting (a backfill's next window, a retry): now means now.
			const pulled = !r.created && (await db.query<{ moved: boolean }>('SELECT app_feed_fetch_now($1) AS moved', [fid])).rows[0]!.moved;
			return { ...r, pulled };
		});
		const { pulled, ...body } = result;
		if (body.created || pulled) await wakeWorker(body.job.id);
		return c.json(body, body.created ? 202 : 200);
	});
