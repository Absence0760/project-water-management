// The runoff model's water balance (RunSummary.runoff) as display rows.
import { CALIBRATION_PARAMS, type RunoffBalance, type RunoffModelId } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';

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

/**
 * "Production store capacity X1 350 mm · Routing store capacity X3 90 mm · Unit hydrograph time base X4 1.7 days":
 * each parameter by its name, as Where the parameters came from writes it, to at most 3 decimals (X2 only when it is
 * not 0). A parameter the model's list doesn't know keeps its key.
 */
export function describeParams(b: RunoffBalance): string {
	const specs = CALIBRATION_PARAMS[b.model as RunoffModelId] ?? [];
	return Object.entries(b.params)
		.filter(([k, v]) => !(b.model === 'gr4j' && k === 'x2' && !v))
		.map(([k, v]) => {
			const spec = specs.find((p) => p.key === k);
			return `${spec?.label ?? k} ${fmtNum(v, 3, true)}${spec?.unit ? ` ${spec.unit}` : ''}`;
		})
		.join(' · ');
}
