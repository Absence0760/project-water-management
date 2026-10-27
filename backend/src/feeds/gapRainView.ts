// The gap-filling products beside CHIRPS for the Data tab (issue #604 R4-E,
// docs/api.md § Data feeds, docs/ui.md § Data): ERA5-Land and IMERG Late over
// one CHIRPS feed's cells, read from the shared cell cache as a run reads
// them (runs/gapRainInput.ts: each 0.05° cell takes the 0.1° cell holding
// it, with its own weight), with each IMERG day's version. Read only: the
// cache fills on the fetch of the CHIRPS feed whose cells the runs read
// (feeds/gapRainFill.ts), and only while settings.gapRain asks for a
// product, so another feed's cells may hold none, and say so (`held`).
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { resolveGapRain, type GapRainSettings } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { gapRainFeed, gapRainRecordStart, GAP_PRODUCT_FIRST_DAY } from '../runs/gapRainInput.js';
import { gridCells, type GridConfig } from './config.js';
import { productVersions, readProductSeries } from './fromMirror.js';

/** One CHIRPS feed the view can read the products over: the outlet's, or a land unit's. */
export interface GapRainFeedOption {
	id: string;
	/** The series it writes: its name, and its id (the Data tab draws its CHIRPS from it). */
	seriesId: string;
	seriesName: string;
	/** The land unit whose rain it is (a unit's own CHIRPS, issue #482); null for the outlet's. */
	nodeId: string | null;
	nodeName: string | null;
	/** The feed whose cells the runs read the products over (runs/gapRainInput.ts gapRainFeed). */
	runsRead: boolean;
}

export interface GapRainProducts {
	/** settings.gapRain as a run takes it; null for CHIRPS alone. */
	gapRain: GapRainSettings | null;
	feeds: GapRainFeedOption[];
	/** The feed read (the one asked for, else the one the runs read, else the first); null without a CHIRPS feed. */
	feed: string | null;
	/** The days read: from the first outlet catchment rain or CHIRPS day (at most back to each product's first) to today. */
	window: { start: string; end: string } | null;
	/** Each product's days over the window, null on a day the cache holds none; `held` = days with a value. */
	era5l: { startDate: string; values: (number | null)[]; held: number } | null;
	imergLate: { startDate: string; values: (number | null)[]; versions: (string | null)[]; held: number } | null;
}

/** Leading and trailing blank days dropped (a product whose cache holds nothing is null). */
function trim<T extends { startDate: string; values: (number | null)[] }>(s: T, extra?: (from: number, to: number) => Partial<T>): (T & { held: number }) | null {
	const first = s.values.findIndex((v) => v !== null);
	if (first < 0) return null;
	let last = s.values.length - 1;
	while (s.values[last] === null) last--;
	const values = s.values.slice(first, last + 1);
	return { ...s, ...extra?.(first, last + 1), startDate: fromEpochDay(toEpochDay(s.startDate) + first), values, held: values.filter((v) => v !== null).length };
}

export async function gapRainProducts(db: Db, projectId: string, feedId: string | null, today = new Date().toISOString().slice(0, 10)): Promise<GapRainProducts> {
	const { rows: settings } = await db.query<{ gapRain: unknown }>(`SELECT settings->'gapRain' AS "gapRain" FROM project WHERE id = $1`, [projectId]);
	const gapRain = resolveGapRain(settings[0]?.gapRain ?? null, []);
	const { rows } = await db.query<{ id: string; config: GridConfig; seriesId: string; seriesName: string; nodeId: string | null; nodeName: string | null }>(
		`SELECT f.id, f.config, t.id AS "seriesId", t.name AS "seriesName", t.site_node_id AS "nodeId", n.name AS "nodeName"
		 FROM data_feed f JOIN time_series t ON t.project_id = f.project_id AND t.feed_id = f.id
		 LEFT JOIN node n ON n.project_id = t.project_id AND n.id = t.site_node_id
		 WHERE f.project_id = $1 AND f.source = 'chirps' AND t.kind = 'rain_chirps_mm'
		 ORDER BY (t.site_node_id IS NULL) DESC, n.name COLLATE "C", t.name COLLATE "C"`,
		[projectId]
	);
	const { rows: read } = await db.query<{ id: string }>(
		`SELECT id FROM time_series WHERE project_id = $1 AND site_node_id IS NULL AND kind = 'rain_chirps_mm' ORDER BY name COLLATE "C" LIMIT 1`,
		[projectId]
	);
	const runs = await gapRainFeed(db, projectId, read[0]?.id ?? null);
	const feeds: GapRainFeedOption[] = rows.map((r) => ({ id: r.id, seriesId: r.seriesId, seriesName: r.seriesName, nodeId: r.nodeId, nodeName: r.nodeName, runsRead: r.id === runs?.feedId }));
	const pick = rows.find((r) => r.id === feedId) ?? rows.find((r) => r.id === runs?.feedId) ?? rows[0] ?? null;
	const empty = { gapRain, feeds, feed: pick?.id ?? null, window: null, era5l: null, imergLate: null };
	const start = pick ? await gapRainRecordStart(db, projectId) : null;
	if (!pick || !start || start > today) return empty;
	const cells = gridCells(pick.config);
	const from = (first: string) => (start < first ? first : start);
	const era = await readProductSeries(db, 'era5l', cells, { start: from(GAP_PRODUCT_FIRST_DAY.era5l), end: today });
	const imergWindow = { start: from(GAP_PRODUCT_FIRST_DAY.imerg_late), end: today };
	const imerg = await readProductSeries(db, 'imerg_late', cells, imergWindow);
	const versions = await productVersions(db, 'imerg_late', imergWindow);
	return {
		...empty,
		window: { start, end: today },
		era5l: trim({ startDate: era.startDate, values: era.values }),
		imergLate: trim({ startDate: imerg.startDate, values: imerg.values, versions }, (a, b) => ({ versions: versions.slice(a, b) }))
	};
}
