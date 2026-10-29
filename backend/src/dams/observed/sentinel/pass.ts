// The Sentinel-2 pass: DE Africa's Sentinel-2 L2A Collection 1 scenes
// (s2_l2a_c1), classified and summed inside each traced dam's outline (s2.ts),
// into the mirror bucket for the worker to load into dam_observation as
// source 's2' (issue #624 step 4; 278_dam_observation_sentinel.sql,
// docs/architecture.md § Dam observations → Sentinel-2). The fetcher runs it
// in its `dams-weekly` mode after the WOfS pass, only with
// DAM_OBSERVATIONS_S2=on (handover.ts damSourceOn; infra/dam_observations.tf
// sets it from dam_s2_enabled). It is the WOfS pass (../wofs/pass.ts
// runScenePass) with Sentinel-2's own parts:
//
//   fetcher ─get─► dams/wanted.json, dams/s2-status.json, dams/s2-state.json
//           ─GET─► explorer.digitalearth.africa/stac/search  collections=s2_l2a_c1, per dam, a year a search
//           ─GET─► deafrica-sentinel-2-l2a-c1…/sentinel-2-c1-l2a/…/{B03,B11,SCL[,B08]}.tif  (headers + the dam's tiles)
//           ─put─► dams/s2/<featureId>.json, dams/s2-status.json, dams/s2-state.json
//
// Differences from WOfS:
// - the backfill goes back to S2_BACKFILL_FROM (2019: Collection 1 is
//   consistent from there, and it bounds the history at ~70 scenes a year);
// - a dam's `since` is the wanted list's sinceBy.s2 (the day after its newest
//   s2 row), else nothing (the backfill start);
// - the bucket is read at most once a second (S2_SCENE_INTERVAL_MS), as the
//   explorer is: issue #624's rule for these hosts. A scene is three or four
//   small range reads per band header and window, so a dam's year is a few
//   minutes of requests, spread over the hourly runs;
// - two MGRS tiles over one dam on a date (they overlap ~10 km) give one row,
//   the better view, as two Landsat rows do.
// A 403 or 429/503 from either host stops the pass and pauses the source for
// a day (handover.ts pausedUntil), with its own heartbeat and recency alarms
// (infra/dam_observations.tf, Source = s2). Locally (FEED_SOURCE=fixtures)
// the scenes are synthetic (fixtures.ts) and pacing is off.
import type { AbsolutePath } from '@zarrita/storage';
import type { FeedHttp } from '../../../feeds/http.js';
import { runScenePass, type ScenePassSource, type WofsPassOptions, type WofsPassResult } from '../wofs/pass.js';
import { S1_RTC_COLLECTION, S2_C1_COLLECTION, searchItems } from '../wofs/stac.js';
import { s1Item, viewS1Scene, type S1Scene } from './s1.js';
import { s2Item, viewS2Scene, type S2Scene } from './s2.js';

/** The backfill's start: Collection 1 is consistent from 2019. */
export const S2_BACKFILL_FROM = '2019-01-01';
/** Minimum gap between two bucket reads' starts: at most one a second (issue #624). */
export const S2_SCENE_INTERVAL_MS = 1000;
export const S2_STATE_KEY = '/dams/s2-state.json' as AbsolutePath;

export const S2_PASS: ScenePassSource<S2Scene> = {
	source: 's2',
	stateKey: S2_STATE_KEY,
	backfillFrom: S2_BACKFILL_FROM,
	sceneIntervalMs: S2_SCENE_INTERVAL_MS,
	since: (o) => o.sinceBy?.s2 ?? S2_BACKFILL_FROM,
	search: (http: FeedHttp, bbox, from, to) => searchItems(http, S2_C1_COLLECTION, s2Item, bbox, from, to),
	view: viewS2Scene
};

/** One Sentinel-2 pass (see the header and ../wofs/pass.ts). */
export const runS2Pass = (opts: WofsPassOptions): Promise<WofsPassResult> => runScenePass(S2_PASS, opts);

// --- Sentinel-1 (issue #624 step 5) -------------------------------------------------------
//
// The Sentinel-1 pass: DE Africa's radiometrically terrain-corrected radar
// (s1_rtc), VV classified and summed inside each traced dam's outline
// (s1.ts), into dams/s1/<featureId>.json for the worker to load as source
// 's1'. The fetcher runs it after the Sentinel-2 pass, only with
// DAM_OBSERVATIONS_S1=measure or on (handover.ts damS1Mode;
// infra/dam_observations.tf sets it from dam_s1_mode; in measure the worker
// loads none of it, in on only the dams whose agreement passes):
//
//   fetcher ─get─► dams/wanted.json, dams/s1-status.json, dams/s1-state.json
//           ─GET─► explorer.digitalearth.africa/stac/search  collections=s1_rtc, per dam, a year a search
//           ─GET─► deafrica-sentinel-1…/s1_rtc/<tile>/…/{…_VV,…_MASK}.tif  (headers + the dam's tiles)
//           ─put─► dams/s1/<featureId>.json, dams/s1-status.json, dams/s1-state.json
//
// As Sentinel-2's: its own backfill start (S1_BACKFILL_FROM), sinceBy.s1,
// one bucket read a second, the better of two views of one date (an
// ascending and a descending pass, or two 1° tiles a dam straddles), its own
// pause, heartbeat and recency alarms (Source = s1). After it the fetcher
// updates the S1/S2 agreement report (agreement.ts).

/**
 * The backfill's start: s1_rtc goes back to 2018, but the agreement with Sentinel-2 (agreement.ts) can only be
 * measured from S2_BACKFILL_FROM, and older radar adds only days WOfS already covers, so the two start together.
 */
export const S1_BACKFILL_FROM = S2_BACKFILL_FROM;
/** Minimum gap between two bucket reads' starts: at most one a second (issue #624). */
export const S1_SCENE_INTERVAL_MS = 1000;
export const S1_STATE_KEY = '/dams/s1-state.json' as AbsolutePath;

export const S1_PASS: ScenePassSource<S1Scene> = {
	source: 's1',
	stateKey: S1_STATE_KEY,
	backfillFrom: S1_BACKFILL_FROM,
	sceneIntervalMs: S1_SCENE_INTERVAL_MS,
	since: (o) => o.sinceBy?.s1 ?? S1_BACKFILL_FROM,
	search: (http: FeedHttp, bbox, from, to) => searchItems(http, S1_RTC_COLLECTION, s1Item, bbox, from, to),
	view: viewS1Scene
};

/** One Sentinel-1 pass (see above and ../wofs/pass.ts). */
export const runS1Pass = (opts: WofsPassOptions): Promise<WofsPassResult> => runScenePass(S1_PASS, opts);
