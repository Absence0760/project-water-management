// Unit tests' stand-in for the cell cache: the CacheView a run of
// chirps_cache_merge (208_chirps_cell_cache.sql) would leave after merging
// these answers in turn, built in memory, so the fetch → cache → feed's days
// path runs without a database. The real function's rules (a final lands on
// a day not final, neither a preliminary value nor a different final replaces
// a final: only the re-check does, 210) are tested against Postgres in
// feeds/cellCache.db.test.ts and feeds/recheck.db.test.ts.
import { toEpochDay } from '@water-management/engine/calendar';
import { type CacheView, decodeCellValue, viewKey } from '../feeds/cellCache.js';
import type { CellsResult } from '../feeds/fetch.js';

export function viewFromAnswers(answers: readonly CellsResult['cells'][], view: CacheView = new Map()): CacheView {
	for (const a of answers) {
		const s = toEpochDay(a.startDate);
		a.cells.forEach(([row, col], c) => {
			for (let d = 0; d < a.read.length; d++) {
				const kind = a.read[d]!;
				if (kind === '-') continue;
				const day = new Date((s + d) * 86_400_000).toISOString().slice(0, 10);
				const year = Number(day.slice(0, 4));
				const key = viewKey({ row, col }, year);
				let y = view.get(key);
				if (!y) view.set(key, (y = { vals: new Array(366).fill(null), final: new Array(366).fill(false) }));
				const doy = s + d - toEpochDay(`${year}-01-01`);
				// A preliminary value never lands on a final one.
				if (kind === 'p' && y.final[doy]) continue;
				const v = decodeCellValue(a.values[c]![d]!);
				// Nor a final on a different final (Object.is: NaN, the sea, is the same as NaN).
				if (y.final[doy] && !Object.is(y.vals[doy], v)) continue;
				y.vals[doy] = v;
				y.final[doy] = kind === 'f';
			}
		});
	}
	return view;
}
