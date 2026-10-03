import { describe, expect, it } from 'vitest';
import type { DamProposals, RegisterDamProposal } from '$lib/api';
import { confirmWords, damProposalRows, fmtDistance, searchedFrom } from './damProposals';

const reg = (registerNo: string, over: Partial<RegisterDamProposal> = {}): RegisterDamProposal => ({
	registerNo,
	name: `Dam ${registerNo}`,
	river: 'Testrivier',
	farm: null,
	lon: 21.3,
	lat: -33.7,
	distanceM: 246,
	capacityM3: 140_000,
	wallHeightM: 6.5,
	surfaceAreaM2: null,
	completionYear: 1998,
	dataset: 'synthetic',
	synthetic: true,
	source: `SYNTHETIC test data: ${registerNo}`,
	loadedAt: '2026-10-01T00:00:00.000Z',
	...over
});

const proposals = (over: Partial<DamProposals> = {}): DamProposals => ({
	nodeId: 'n1',
	nodeName: 'Upper farm',
	current: { damCapacityM3: 100_000, damAreaFullM2: null },
	dam: { id: 'f1', name: 'Upper dam', geometryType: 'Polygon', point: [21.3, -33.7], areaM2: 39_000 },
	radiusM: 1000,
	register: [reg('Z100/07'), reg('Z100/09', { capacityM3: null, distanceM: 880 })],
	area: { featureId: 'f1', featureName: 'Upper dam', areaM2: 39_012.4, method: 'the dam polygon’s area' },
	datasets: [{ dataset: 'synthetic', count: 8 }],
	...over
});

describe('damProposalRows', () => {
	it('lists each registered dam’s capacity with its source, then the polygon’s area', () => {
		const rows = damProposalRows(proposals());
		expect(rows.map((r) => r.key)).toEqual(['Z100/07', 'Z100/09', 'area']);
		expect(rows[0]).toMatchObject({ kind: 'capacity', label: 'Capacity: Dam Z100/07 (Z100/07)', missing: false, same: false, value: 140_000, synthetic: true });
		expect(rows[0]!.source).toBe('The register of dams, “synthetic”: SYNTHETIC test data: Z100/07');
		expect(rows[0]!.detail).toMatch(/^250 m from the dam on the map · wall 6.5 m · completed 1998 · on the Testrivier$/);
		expect(rows[1]).toMatchObject({ missing: true, proposed: 'Not in the register', value: null });
		expect(rows[2]).toMatchObject({ kind: 'area', featureId: 'f1', label: 'Full-supply area: “Upper dam”', now: 'Not set (estimated from capacity)', same: false, value: 39_012.4 });
		expect(rows[2]!.source).toMatch(/^The map: /);
	});

	it('marks a value the saved model already holds as the same, to the nearest unit', () => {
		const rows = damProposalRows(proposals({ current: { damCapacityM3: 140_000, damAreaFullM2: 39_012.2 } }));
		expect(rows[0]!.same).toBe(true);
		expect(rows[2]!.same).toBe(true);
	});

	it('has no area row for a point or no dam, and no rows with nothing near', () => {
		expect(damProposalRows(proposals({ area: null })).map((r) => r.key)).toEqual(['Z100/07', 'Z100/09']);
		expect(damProposalRows(proposals({ dam: null, register: [], area: null }))).toEqual([]);
	});
});

describe('confirmWords', () => {
	it('names the unit, the old and new value and the source', () => {
		const p = proposals();
		const [cap, , area] = damProposalRows(p);
		const c = confirmWords(p, cap!);
		expect(c.title).toBe('Set Upper farm’s dam capacity from the register?');
		expect(c.message).toMatch(/^Upper farm’s dam capacity changes from 100\D000 m³ to 140\D000 m³, the registered capacity of Dam Z100\/07 \(Z100\/07\)\./);
		expect(c.confirmLabel).toBe('Use this capacity');
		const a = confirmWords(p, area!);
		expect(a.message).toMatch(/^Upper farm’s dam has no area when full set \(the run estimates one from its capacity\); it becomes 39\D012 m² \(3[.,]9 ha\), the area of “Upper dam” computed on the server/);
		const set = proposals({ current: { damCapacityM3: 100_000, damAreaFullM2: 20_000 } });
		expect(confirmWords(set, damProposalRows(set)[2]!).message).toMatch(/^Upper farm’s dam area when full changes from 20\D000 m² \(2[.,]0 ha\) to 39\D012 m²/);
		expect(a.confirmLabel).toBe('Use this area');
	});
});

describe('fmtDistance', () => {
	it('rounds to 10 m under a kilometre, else km to one place', () => {
		expect(fmtDistance(246)).toBe('250 m');
		expect(fmtDistance(1234)).toMatch(/^1[.,]2 km$/);
	});
});

describe('searchedFrom', () => {
	it('writes the place in degrees with a hemisphere, as the rest of the app does', () => {
		const dam = { id: 'f', name: 'Upper dam', geometryType: 'Polygon' as const, point: [18.45, -33.72] as [number, number], areaM2: 40_000 };
		expect(searchedFrom(dam)).toBe('Searched from “Upper dam” (its polygon’s centre, 33.7200° S, 18.4500° E)');
		expect(searchedFrom({ ...dam, name: '', geometryType: 'Point', point: [-0.5, 51.5] })).toBe('Searched from the dam on the map (a point, 51.5000° N, 0.5000° W)');
	});
});
