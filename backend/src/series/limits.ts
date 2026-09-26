// The series limits the data feeds share with the series routes. Kept apart
// from merge.ts so the fetcher Lambda (lambda-fetcher.ts), which needs these
// but not SERIES_KINDS, reaches only the engine's calendar module and not its
// model (the bundle guard in lambda-fetcher.test.ts).
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { z } from 'zod';

export const MAX_SERIES_VALUES = 60_000;

/**
 * A series' first day: a real calendar date. The regex alone lets 2021-02-30
 * through to Postgres, which fails it as a 500. Shared with the project
 * document (projects/document.ts).
 */
export const SeriesStartDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromEpochDay(toEpochDay(s)) === s, 'not a calendar date');
