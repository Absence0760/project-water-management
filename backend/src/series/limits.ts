// The series limits the data feeds share with the series routes. Kept apart
// from merge.ts so the fetcher Lambda (lambda-fetcher.ts), which needs these
// but not SERIES_KINDS, reaches only the engine's calendar module and not its
// model (the bundle guard in lambda-fetcher.test.ts).
import { fromEpochDay, toEpochDay, isIsoDate } from '@water-management/engine/calendar';
import { z } from 'zod';

export const MAX_SERIES_VALUES = 60_000;

/**
 * Largest magnitude a stored series value may have, in its canonical unit
 * (mm or m³/s). A day's rain is at most a few hundred mm and the largest
 * river's flow ~2×10⁵ m³/s, so this refuses only junk (a logger's overflow
 * sentinel, a unit conversion that overflowed to Infinity) before it reaches
 * the engine, whose sums over areas would carry it into every result.
 */
export const MAX_SERIES_ABS_VALUE = 1e12;

/**
 * Most series one project holds. A catchment has a few per kind (a rain
 * series per gauge, a flow series per weir): tens, not hundreds. Without a
 * cap one 5 MB project file created 50 000 empty series in a single
 * 12-second transaction; every write path that creates a series checks it.
 */
export const SERIES_PER_PROJECT_MAX = 1000;

/**
 * A series' first day: a real calendar date. The regex alone lets 2021-02-30
 * through to Postgres, which fails it as a 500. Shared with the project
 * document (projects/document.ts).
 */
export const SeriesStartDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => isIsoDate(s), 'not a calendar date');
