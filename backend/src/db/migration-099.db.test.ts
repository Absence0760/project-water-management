// Migration 099: a new farm's irrigation efficiency defaults to drip (0.9,
// issue #90), matching the engine's NEW_FARM_IRRIGATION (docs/data-model.md
// § node). The row-level mapping 006 did is pinned by migration-006.db.test.ts;
// 197 replaced the loss return with the return flow (migration-197.db.test.ts).
import { NEW_FARM_IRRIGATION } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asOwner } from '../__tests__/helpers.js';

describe('migration 099: drip as the default irrigation efficiency', () => {
	it('defaults node.irrigation_efficiency to the engine’s new-farm value, 0.9, and the return flow to 0.1 (197)', async () => {
		const rows = (await asOwner(
			`SELECT column_name, column_default FROM information_schema.columns
			 WHERE table_schema = 'public' AND table_name = 'node' AND column_name IN ('irrigation_efficiency', 'return_flow_fraction')
			 ORDER BY column_name`
		)) as { column_name: string; column_default: string }[];
		expect(rows.map((r) => [r.column_name, Number(r.column_default)])).toEqual([
			['irrigation_efficiency', NEW_FARM_IRRIGATION.irrigationEfficiency],
			['return_flow_fraction', NEW_FARM_IRRIGATION.returnFlowFraction]
		]);
		expect(NEW_FARM_IRRIGATION.irrigationEfficiency).toBe(0.9);
	});
});
