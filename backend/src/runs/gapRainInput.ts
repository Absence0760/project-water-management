// The gap-filling products a run reads (engine ≥ 1.101.0, issue #604 R4-B,
// settings.gapRain, docs/model.md §2.4b *Gap-filling product*,
// docs/architecture.md § Our copy of the rain data).
//
// ERA5-Land and IMERG Late reach a run as CHIRPS does: through the shared
// cell cache, over the cells of the CHIRPS feed that writes the CHIRPS series
// the run reads (the first outlet `rain_chirps_mm` by name; else the first
// such series a CHIRPS feed writes), so each product is the same area's
// weighted mean as the CHIRPS it stands in for (feeds/fromMirror.ts
// readProductSeries: each 0.05° cell reads the 0.1° cell holding it, with its
// own weight). Filling the cache from our copy is the feed's fetch's
// (feeds/gapRainFill.ts, 252: only a running CHIRPS feed_fetch job writes the
// cache); a run only reads. Neither is a stored series: the run's input
// snapshot (run_input_series, series_id null) keeps what it read, as the
// reference cell's CHIRPS (runs/referenceCell.ts).
//
// IMERG Late is split by version, one input series per version
// (engine imergSeriesKey), from each day's version in the cache
// (productVersions, the chirps_file tag): the engine fits each version on its
// own, and labels each day it fills with its version.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { type DailySeries, ERA5L_SERIES_KEY, IMERG_VERSION_RE, imergSeriesKey, resolveGapRain } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { type GridConfig, gridCells, type WeightedCell } from '../feeds/config.js';
import { productVersions, readProductSeries } from '../feeds/fromMirror.js';

/** The first day each product's cache can hold (252 mirror_product_first_day). */
export const GAP_PRODUCT_FIRST_DAY = { era5l: '1950-01-01', imerg_late: '2000-06-01' } as const;

/** The product labels a run's input snapshot records (provenance only; the engine reads the key). */
export const ERA5L_PROVENANCE = { product: 'ERA5-Land', version: 'daily' } as const;
export const imergProvenance = (version: string) => ({ product: 'IMERG Late', version });

/**
 * The CHIRPS feed whose cells the products are read over: the one that
 * writes the outlet CHIRPS series the run reads (`chirpsSeriesId`), else the
 * first outlet CHIRPS series by name a CHIRPS feed writes. Null when no CHIRPS
 * feed writes one (an uploaded or imported CHIRPS record names no cells).
 */
export async function gapRainFeed(db: Db, projectId: string, chirpsSeriesId: string | null): Promise<{ feedId: string; cells: WeightedCell[] } | null> {
	const { rows } = await db.query<{ id: string; config: GridConfig }>(
		`SELECT f.id, f.config FROM data_feed f JOIN time_series t ON t.project_id = f.project_id AND t.feed_id = f.id
		 WHERE f.project_id = $1 AND f.source = 'chirps' AND t.kind = 'rain_chirps_mm' AND t.site_node_id IS NULL
		 ORDER BY (t.id::text = $2) DESC, t.name COLLATE "C" LIMIT 1`,
		[projectId, chirpsSeriesId ?? '']
	);
	if (!rows[0]) return null;
	return { feedId: rows[0].id, cells: gridCells(rows[0].config) };
}

/** The first day of the outlet catchment rain and CHIRPS records the run reads (the fits need the products over their overlap); null without either. */
export async function gapRainRecordStart(db: Db, projectId: string): Promise<string | null> {
	const { rows } = await db.query<{ start: string | null }>(
		`SELECT to_char(min(start_date), 'YYYY-MM-DD') AS start FROM time_series
		 WHERE project_id = $1 AND site_node_id IS NULL AND kind IN ('rain_catchment_mm', 'rain_chirps_mm')`,
		[projectId]
	);
	return rows[0]?.start ?? null;
}

/** A cached series with its leading blank days dropped; null when it holds no value. */
function trimmed(s: { startDate: string; values: (number | null)[] }): DailySeries | null {
	const first = s.values.findIndex((v) => v !== null);
	if (first < 0) return null;
	return { startDate: fromEpochDay(toEpochDay(s.startDate) + first), values: s.values.slice(first) };
}

/**
 * The run input series settings.gapRain asks for, from the cell cache: ERA5-Land
 * under ERA5L_SERIES_KEY when the product is `era5l` or `chirpsThenEra5l`, and
 * one series per IMERG version with imergLate. Null when the settings ask for
 * none (CHIRPS alone), so such a run's input is as before. A product the cache
 * holds nothing of for the cells is left out, and the engine says so.
 */
export async function gapRainInputs(
	db: Db,
	projectId: string,
	settings: { gapRain?: unknown },
	chirpsSeriesId: string | null,
	today = new Date().toISOString().slice(0, 10)
): Promise<Record<string, DailySeries> | null> {
	const gap = resolveGapRain(settings.gapRain, []);
	if (!gap) return null;
	const out: Record<string, DailySeries> = {};
	const feed = await gapRainFeed(db, projectId, chirpsSeriesId);
	const start = await gapRainRecordStart(db, projectId);
	if (!feed || !start) return out;
	const window = (first: string) => ({ start: start < first ? first : start, end: today });
	if (gap.product !== 'chirps') {
		const w = window(GAP_PRODUCT_FIRST_DAY.era5l);
		const s = w.start <= w.end ? trimmed(await readProductSeries(db, 'era5l', feed.cells, w)) : null;
		if (s) out[ERA5L_SERIES_KEY] = { ...s, provenance: { ...ERA5L_PROVENANCE } };
	}
	if (gap.imergLate) {
		const w = window(GAP_PRODUCT_FIRST_DAY.imerg_late);
		if (w.start <= w.end) {
			const s = await readProductSeries(db, 'imerg_late', feed.cells, w);
			const versions = await productVersions(db, 'imerg_late', w);
			const byVersion = new Map<string, (number | null)[]>();
			s.values.forEach((v, i) => {
				const ver = versions[i];
				// A day without a valid version can't be fitted with any version's days: it stays out.
				if (v === null || !ver || !IMERG_VERSION_RE.test(ver)) return;
				let vs = byVersion.get(ver);
				if (!vs) byVersion.set(ver, (vs = new Array<number | null>(s.values.length).fill(null)));
				vs[i] = v;
			});
			for (const [ver, values] of [...byVersion].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
				let last = values.length - 1;
				while (last >= 0 && values[last] === null) last--;
				const t = trimmed({ startDate: s.startDate, values: values.slice(0, last + 1) });
				if (t) out[imergSeriesKey(ver)] = { ...t, provenance: imergProvenance(ver) };
			}
		}
	}
	return out;
}
