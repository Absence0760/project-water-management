import { describe, expect, it } from 'vitest';
import type { MapFeature } from '#lib/api/types.js';
import { niceCeil, registeredBreaks, registeredColours, registeredLayers, registeredScheme, registeredSentence, registeredShading, registeredStep, REGISTERED_STEPS, stepLabel } from './registeredMap';
import type { RegisteredFigures } from './registeredUsers';
import { useMapData } from './useMap';

const square = (x: number): MapFeature['geometry'] => ({
	type: 'Polygon',
	coordinates: [
		[
			[x, -33],
			[x + 0.1, -33],
			[x + 0.1, -33.1],
			[x, -33.1],
			[x, -33]
		]
	]
});
const parcel = (id: string, nodeId: string | null, x: number, areaM2 = 1_000): MapFeature =>
	({ id, kind: 'farm_parcel', nodeId, nodeName: null, name: id, geometry: square(x), areaM2 }) as unknown as MapFeature;

const figs = (volumeM3: number | null, areaHa: number | null = null, storageM3: number | null = null): RegisteredFigures => ({ volumeM3, areaHa, storageM3 });

describe('the registered scale', () => {
	it('rounds the step up to a round number', () => {
		expect([niceCeil(1), niceCeil(1.2), niceCeil(2.2), niceCeil(3), niceCeil(7), niceCeil(9), niceCeil(48_000), niceCeil(0)]).toEqual([1, 1.5, 2.5, 3, 8, 10, 50_000, 1]);
	});

	it('cuts five equal steps from 0 to a round number at or above the largest figure, edges inclusive', () => {
		const b = registeredBreaks([12_000, 180_000, 240_000]);
		expect(b).toEqual([50_000, 100_000, 150_000, 200_000, 250_000]);
		expect(registeredStep(50_000, b)).toBe('s1');
		expect(registeredStep(50_001, b)).toBe('s2');
		expect(registeredStep(240_000, b)).toBe('s5');
		expect(registeredStep(0, b)).toBe('none');
		expect(registeredStep(null, b)).toBe('none');
		expect(stepLabel('s1', b, 'use')).toMatch(/^Up to 50\s000 m³\/a$/);
		expect(stepLabel('s3', b, 'use')).toMatch(/^More than 100\s000, up to 150\s000 m³\/a$/);
		expect(stepLabel('s2', registeredBreaks([9]), 'area')).toBe('More than 2, up to 4 ha');
	});

	it('puts every label at 4.5:1 or more on its step, light and dark', () => {
		const lum = (hex: string) => {
			const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const contrast = (a: string, b: string) => {
			const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
			return (x + 0.05) / (y + 0.05);
		};
		for (const dark of [false, true]) {
			const c = registeredColours(dark);
			for (const s of [...REGISTERED_STEPS, 'none'] as const) expect(contrast(c[s].text, c[s].fill), `${dark ? 'dark' : 'light'} ${s}`).toBeGreaterThanOrEqual(4.5);
			// Each step reads darker than the one before.
			for (let i = 1; i < REGISTERED_STEPS.length; i++) expect(lum(c[REGISTERED_STEPS[i]!].fill)).toBeLessThan(lum(c[REGISTERED_STEPS[i - 1]!].fill));
		}
	});
});

describe('registeredShading', () => {
	const units = [
		{ id: 'u1', name: 'Upper' },
		{ id: 'u2', name: 'Lower' },
		{ id: 'u3', name: 'Mapless' },
		{ id: 'u4', name: 'Bare' }
	];
	const subtotals = new Map([
		['u1', figs(240_000, 30, 100_000)],
		['u2', figs(12_000, null, null)],
		['u3', figs(180_000, 20, null)]
	]);
	const features = [parcel('p1', 'u1', 21, 5_000), parcel('p1b', 'u1', 21.5, 100), parcel('p2', 'u2', 22), parcel('p4', 'u4', 23), parcel('stray', null, 24)];

	it('shades each unit with an area by its registered figure, lists the rest, and needs no run', () => {
		const s = registeredShading(units, subtotals, features, 'use');
		expect(s.drawn.map((u) => [u.name, u.band, u.label])).toEqual([
			['Upper', 's5', expect.stringMatching(/^240\s000 m³\/a$/)],
			['Lower', 's1', expect.stringMatching(/^12\s000 m³\/a$/)],
			['Bare', 'none', 'None registered']
		]);
		expect(s.unplaced.map((u) => u.name)).toEqual(['Mapless']);
		expect(s.notInRun).toEqual([]);
		// Every polygon of a unit, its label in the largest.
		expect(s.drawn[0]!.polygons.map((p) => p.featureId)).toEqual(['p1', 'p1b']);
		expect(s.drawn[0]!.at![0]).toBeLessThan(21.2);
		expect(useMapData(s).features.map((f) => f.properties.band)).toEqual(['s5', 's5', 's1', 'none']);
	});

	it('reads the measure picked: the irrigated area and the dam capacity, a unit with none stated as nothing registered', () => {
		const area = registeredShading(units, subtotals, features, 'area');
		expect(area.drawn.map((u) => [u.band, u.label])).toEqual([
			['s5', '30 ha'],
			['none', 'None registered'],
			['none', 'None registered']
		]);
		const dam = registeredShading(units, subtotals, features, 'storage');
		expect(dam.drawn[0]!.label).toMatch(/^100\s000 m³$/);
		expect(registeredSentence(dam.drawn[0]!, 'storage')).toMatch(/^Upper: 100\s000 m³ registered farm dam capacity, in force today\.$/);
		expect(registeredSentence(dam.drawn[1]!, 'storage')).toBe('Lower: None registered (registered farm dam capacity, in force today).');
	});

	it('draws through its own scheme: a fill per step, no fill for nothing registered', () => {
		const layers = registeredLayers(false, 'use');
		expect(layers[0]!.filter).toEqual(['in', ['get', 'band'], ['literal', ['s1', 's2', 's3', 's4', 's5']]]);
		const scheme = registeredScheme('use', 'use');
		expect(scheme.id).toBe('registered');
		expect(scheme.ariaLabel).toBe('Hydrological units shaded by registered water use');
		expect(scheme.colours(true).s5.fill).toBe(registeredColours(true).s5.fill);
	});
});
