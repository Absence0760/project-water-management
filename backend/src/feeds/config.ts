// What a data feed is (018_feeds.sql, roadmap WP-2.10): a source, where in
// that source to read (grid cells or a gauge station), and which of the
// project's series the values merge into. Pure: the routes, the handlers and
// the fetcher Lambda all validate with these schemas.
import type { SeriesKind } from '@water-management/engine';
import { z } from 'zod';
import { SeriesStartDate } from '../series/merge.js';

export const FEED_SOURCES = ['chirps', 'chirps_gefs', 'dws'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];

export const FEED_SCHEDULES = ['daily', 'hourly'] as const;
export type FeedSchedule = (typeof FEED_SCHEDULES)[number];

export interface SourceSpec {
	label: string;
	/** Series kinds a feed of this source may write, the first being the default. */
	kinds: readonly SeriesKind[];
	unit: string;
	/**
	 * A feed is stale when its newest day is more than this many days before
	 * today (UTC): the source's normal publishing lag plus a margin. Negative
	 * for a forecast, whose newest day is in the future.
	 */
	staleAfterDays: number;
}

export const SOURCES: Record<FeedSource, SourceSpec> = {
	// Preliminary CHIRPS v3 comes out two days after each pentad ends, so the
	// newest day is normally 2–7 days old.
	chirps: { label: 'CHIRPS daily rainfall', kinds: ['rain_chirps_mm', 'rain_catchment_mm'], unit: 'mm', staleAfterDays: 12 },
	// A new 16-day forecast is issued daily; at least 12 days ahead means one
	// was issued in the last few days.
	chirps_gefs: { label: 'CHIRPS-GEFS rainfall forecast', kinds: ['rain_forecast_mm'], unit: 'mm', staleAfterDays: -12 },
	// Verified DWS flow lags by months (docs/architecture.md § Data feeds).
	dws: { label: 'DWS gauge flow', kinds: ['flow_observed_m3s', 'flow_reference_m3s', 'flow_logger_m3s'], unit: 'm³/s', staleAfterDays: 240 }
};

const Lat = z.number().finite().min(-60).max(60);
const Lon = z.number().finite().min(-180).max(180);

/**
 * CHIRPS begins on this day; every earlier day is a 404. A start date before
 * it would make the first window all empty, and with no newest day to move
 * on from, every later fetch would read that same empty window again.
 */
export const CHIRPS_FIRST_DAY = '1981-01-01';

/** CHIRPS / CHIRPS-GEFS: the rainfall is the weighted mean of these 0.05° cells. */
export const GridConfig = z
	.object({
		cells: z
			.array(z.object({ lat: Lat, lon: Lon, weight: z.number().finite().positive().max(1000).default(1) }).strict())
			.min(1)
			.max(25),
		/** First day to fetch when the feed has no data yet (default: 60 days back), and never fetched before. */
		startDate: SeriesStartDate.refine((d) => d >= CHIRPS_FIRST_DAY, `CHIRPS begins on ${CHIRPS_FIRST_DAY}`).optional(),
		staleAfterDays: z.number().int().min(-15).max(3650).optional()
	})
	.strict();

/** DWS: a station code, e.g. X0H000 (letter, digit, letter, three digits; synthetic here). */
export const DWS_STATION = /^[A-Z]\d[A-Z]\d{3}$/;
export const DwsConfig = z
	.object({
		station: z
			.string()
			.trim()
			.transform((s) => s.toUpperCase())
			.pipe(z.string().regex(DWS_STATION, 'a DWS station code looks like A2H012')),
		/** First day to fetch when the feed has no data yet (default: 10 years back), and never fetched before. */
		startDate: SeriesStartDate.optional(),
		staleAfterDays: z.number().int().min(1).max(3650).optional()
	})
	.strict();

export type GridConfig = z.output<typeof GridConfig>;
export type DwsConfig = z.output<typeof DwsConfig>;
export type FeedConfig = GridConfig | DwsConfig;

/** The config schema for a source. */
export const configSchema = (source: FeedSource) => (source === 'dws' ? DwsConfig : GridConfig);

/** Parse a feed's source + config + target together; zod issues point at the field. */
export const FeedInput = z
	.object({
		source: z.enum(FEED_SOURCES),
		config: z.unknown(),
		targetKind: z.string().optional(),
		targetName: z.string().trim().max(100).default(''),
		schedule: z.enum(FEED_SCHEDULES).default('daily'),
		enabled: z.boolean().default(true)
	})
	.strict()
	.transform((v, ctx) => {
		const config = configSchema(v.source).safeParse(v.config);
		if (!config.success) {
			for (const issue of config.error.issues) ctx.addIssue({ ...issue, path: ['config', ...issue.path] } as never);
			return z.NEVER;
		}
		const kinds = SOURCES[v.source].kinds as readonly string[];
		const targetKind = v.targetKind ?? kinds[0]!;
		if (!kinds.includes(targetKind)) {
			ctx.addIssue({ code: 'custom', path: ['targetKind'], message: `a ${v.source} feed writes one of ${kinds.join(', ')}` });
			return z.NEVER;
		}
		return { ...v, config: config.data as FeedConfig, targetKind: targetKind as SeriesKind };
	});
export type FeedInput = z.output<typeof FeedInput>;

/** PATCH: any of the fields; the route merges them over the saved feed and parses the whole with FeedInput. */
export const FeedPatch = z
	.object({
		source: z.enum(FEED_SOURCES).optional(),
		config: z.unknown().optional(),
		targetKind: z.string().optional(),
		targetName: z.string().trim().max(100).optional(),
		schedule: z.enum(FEED_SCHEDULES).optional(),
		enabled: z.boolean().optional()
	})
	.strict();
