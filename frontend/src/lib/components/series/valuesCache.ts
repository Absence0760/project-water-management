// Per-session cache of input-series values (keyed "projectId/seriesId"), so
// revisiting the Time series tab draws coverage and charts on the first frame.
import type { Daily } from './coverage';

export const valuesCache = new Map<string, Daily>();
