// The runoff model's water balance (RunSummary.runoff) as display rows.
import type { RunoffBalance } from '@water-management/engine';

export interface BalanceRow {
	key: 'rain' | 'aet' | 'flow' | 'exchange' | 'storage';
	label: string;
	/** mm over the catchment for the whole run. */
	mm: number;
	/** Share of the rain, or null without rain. */
	ofRain: number | null;
}

const MODEL_NAMES: Record<RunoffBalance['model'], string> = { gr4j: 'GR4J' };

export const runoffModelName = (b: Pick<RunoffBalance, 'model'>) => MODEL_NAMES[b.model] ?? b.model;

/**
 * Rain in; evaporation, flow and the change in storage out; exchange only
 * when there was any. The rows close: rain + exchange = AET + flow + Δstorage.
 */
export function balanceRows(b: RunoffBalance): BalanceRow[] {
	const share = (mm: number) => (b.rainMm > 0 ? mm / b.rainMm : null);
	const rows: BalanceRow[] = [
		{ key: 'rain', label: 'Rain', mm: b.rainMm, ofRain: share(b.rainMm) },
		{ key: 'aet', label: 'Actual evaporation', mm: b.aetMm, ofRain: share(b.aetMm) },
		{ key: 'flow', label: 'Natural flow', mm: b.flowMm, ofRain: share(b.flowMm) },
		{ key: 'storage', label: 'Change in storage', mm: b.storageEndMm - b.storageStartMm, ofRain: share(b.storageEndMm - b.storageStartMm) }
	];
	if (b.exchangeMm !== 0) rows.splice(3, 0, { key: 'exchange', label: 'Groundwater exchange (+ gained)', mm: b.exchangeMm, ofRain: share(b.exchangeMm) });
	return rows;
}

/** "X1 350 mm · X3 90 mm · X4 1.7 days" (X2 only when it is not 0). */
export function describeParams(b: RunoffBalance): string {
	const p = b.params;
	if (b.model !== 'gr4j') return Object.entries(p).map(([k, v]) => `${k} ${v}`).join(' · ');
	const parts = [`X1 ${p.x1} mm`];
	if (p.x2) parts.push(`X2 ${p.x2} mm/day`);
	parts.push(`X3 ${p.x3} mm`, `X4 ${p.x4} days`);
	return parts.join(' · ');
}
