// Summary → Supply by farm: every farm in the latest run with the share of
// its irrigation demand supplied, fullest first and emptiest last, banded as
// the Network's "Colour farms by: Supply" (network/supplyColour.ts), so the
// two never disagree. Farms without demand go last: 100 % of nothing isn't a
// result.
import type { FarmSummary } from '@water-management/engine';
import { farmSupply, type SupplyBand } from '$lib/components/network/supplyColour';

export interface SupplyBar {
	nodeId: string;
	name: string;
	band: SupplyBand;
	/** 0–1, null without demand. */
	fraction: number | null;
	/** Still a farm in the model, so its name can open the farm drawer. */
	inModel: boolean;
}

export function supplyBars(farms: readonly FarmSummary[], modelFarmIds: ReadonlySet<string>): SupplyBar[] {
	const rows = farms.map((f): SupplyBar => {
		const s = farmSupply(f);
		return { nodeId: f.nodeId, name: f.name || 'Unnamed farm', band: s.band, fraction: s.fraction, inModel: modelFarmIds.has(f.nodeId) };
	});
	return rows.sort((a, b) => {
		if (a.fraction === null || b.fraction === null) return a.fraction === null ? (b.fraction === null ? a.name.localeCompare(b.name) : 1) : -1;
		return b.fraction - a.fraction || a.name.localeCompare(b.name);
	});
}
