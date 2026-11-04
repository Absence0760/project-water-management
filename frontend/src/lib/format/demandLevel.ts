// A demand level (% of today's demand, the outcome matrix's and the seasonal
// outlook's levels, issue #53) in plain words, for the rows both panels head
// with it. One place, so the two never word a level differently.
import { fmtNum } from './number.js';

/** 100 → "Today’s demand", 85 → "15 % less demand", 120 → "20 % more demand", 0 → "No irrigation demand"; null → null. */
export function levelDescription(pct: number | null): string | null {
	if (pct === null || !Number.isFinite(pct)) return null;
	if (pct === 100) return 'Today’s demand';
	if (pct === 0) return 'No irrigation demand';
	return pct < 100 ? `${fmtNum(100 - pct, 1, true)} % less demand` : `${fmtNum(pct - 100, 1, true)} % more demand`;
}
