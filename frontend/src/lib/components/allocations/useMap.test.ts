import { compareAllocations } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { MapFeature, MapGeometry } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { BAND_LABEL, BAND_SHORT, bandColours, hatchPixels, unitUse, useBand, useBounds, useLabel, useLayers, useMapData, useSentence, useShading, USE_BANDS, wholeWaterYears } from './useMap';

describe('useBand: modelled use ÷ registered volume', () => {
	it('puts each edge in the band the issue fixes (#510)', () => {
		const at = (r: number) => useBand(r * 100_000, 100_000);
		expect(at(0.99)).toBe('under');
		expect(at(1.0)).toBe('near');
		expect(at(1.1)).toBe('near');
		expect(at(1.1001)).toBe('over');
		expect(at(1.5)).toBe('over');
		expect(at(1.5001)).toBe('far');
		expect(at(0)).toBe('under');
		expect(at(4)).toBe('far');
	});

	it('reads r = 1 as the orange band even after float dust from summing and dividing', () => {
		expect(useBand(100_000 * (1 - 1e-12), 100_000)).toBe('near');
		expect(useBand(110_000.00000001, 100_000)).toBe('near');
		// Real differences stay: 1 m³ under on 100 000 is under.
		expect(useBand(99_999, 100_000)).toBe('under');
	});

	it('use with nothing registered, and neither', () => {
		expect(useBand(5, 0)).toBe('unregistered');
		expect(useBand(0, 0)).toBe('none');
		expect(useBand(1e-9, 0)).toBe('none');
	});

	it('every band has legend words and short words, never a legal finding', () => {
		for (const b of USE_BANDS) {
			expect(BAND_LABEL[b]).toBeTruthy();
			expect(BAND_SHORT[b]).toBeTruthy();
		}
		expect([...Object.values(BAND_LABEL), ...Object.values(BAND_SHORT)].join(' ')).not.toMatch(/lawful|illegal|legal|complian|violat|breach/i);
	});
});

/** Two whole water years (2001/02, 2002/03) and a part year (2003/04, 30 days). */
const comparison = () =>
	compareAllocations({
		startDate: '2001-10-01',
		nodes: [
			// 100 m³/day surface: 36 500 a year (36 600 in a leap year).
			{ nodeId: 'A', name: 'Farm A', kind: 'farm', supplied: new Array(760).fill(100) },
			// 20 m³/day, half of it groundwater.
			{ nodeId: 'B', name: 'Farm B', kind: 'farm', supplied: new Array(760).fill(20), groundwater: new Array(760).fill(10) },
			{ nodeId: 'C', name: 'Farm C', kind: 'farm', supplied: new Array(760).fill(0) },
			{ nodeId: 'D', name: 'User D', kind: 'user', supplied: new Array(760).fill(50) }
		],
		allocations: [
			{ id: 'a', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 36_500 / 1.3 },
			{ id: 'b1', nodeId: 'B', waterSource: 'surface', volumeM3PerYear: 3_650 / 1.25 },
			{ id: 'b2', nodeId: 'B', waterSource: 'groundwater', volumeM3PerYear: 3_650 / 2 }
		]
	});

const parcel = (id: string, nodeId: string | null, x: number, w = 1, areaM2 = 1e6, kind: MapFeature['kind'] = 'farm_parcel'): MapFeature => {
	const geometry: MapGeometry = {
		type: 'Polygon',
		coordinates: [
			[
				[x, 0],
				[x + w, 0],
				[x + w, 1],
				[x, 1],
				[x, 0]
			]
		]
	};
	return { id, kind, name: id, nodeId, nodeName: nodeId ? `Unit ${nodeId}` : null, geometry, properties: {}, areaM2, nonContributingM2: null, damPosition: null, center: [x + w / 2, 0.5], sourceId: null, createdBy: null, createdAt: '', updatedAt: '' };
};

describe('unitUse and wholeWaterYears', () => {
	it('lists the whole water years only (the part year is left out, as in the comparison)', () => {
		expect(wholeWaterYears(comparison())).toEqual([2001, 2002]);
	});

	it('the mean over whole water years by default, one whole year when picked', () => {
		const c = comparison();
		const a = c.nodes.find((n) => n.nodeId === 'A')!;
		const mean = unitUse(a, 'surface', null)!;
		expect(mean.band).toBe('over');
		// Both whole years used 36 500 m³ against a volume of 36 500 / 1.3.
		expect(mean.ratio!).toBeCloseTo(1.3, 6);
		expect(unitUse(a, 'surface', 2002)!.modelledM3).toBe(36_500);
		// The part year isn't offered, and a year outside the run has nothing.
		expect(unitUse(a, 'surface', 2003)).toBeNull();
		expect(unitUse(a, 'surface', 1990)).toBeNull();
	});

	it('the source toggle: surface, groundwater, and both as total use ÷ total registered', () => {
		const b = comparison().nodes.find((n) => n.nodeId === 'B')!;
		expect(unitUse(b, 'surface', null)).toMatchObject({ band: 'over' });
		expect(unitUse(b, 'surface', null)!.ratio).toBeCloseTo(1.25, 6);
		expect(unitUse(b, 'groundwater', null)!.ratio).toBeCloseTo(2, 6);
		expect(unitUse(b, 'groundwater', null)!.band).toBe('far');
		const both = unitUse(b, 'both', null)!;
		expect(both.modelledM3).toBeCloseTo(7_300, 6);
		expect(both.registeredM3).toBeCloseTo(3_650 / 1.25 + 3_650 / 2, 6);
		expect(both.ratio).toBeCloseTo(7_300 / (3_650 / 1.25 + 3_650 / 2), 6);
	});

	it('units with nothing registered: use is the hatched band, neither is outline only', () => {
		const c = comparison();
		expect(unitUse(c.nodes.find((n) => n.nodeId === 'D')!, 'surface', null)).toMatchObject({ band: 'unregistered', ratio: null });
		expect(unitUse(c.nodes.find((n) => n.nodeId === 'C')!, 'surface', null)).toMatchObject({ band: 'none', ratio: null });
		expect(unitUse(c.nodes.find((n) => n.nodeId === 'A')!, 'groundwater', null)).toMatchObject({ band: 'none' });
	});

	it('labels: the % of registered, or the band in words', () => {
		expect(useLabel({ ratio: 1.3197, band: 'over' })).toBe('132 %');
		expect(useLabel({ ratio: null, band: 'unregistered' })).toBe('None registered');
		expect(useLabel({ ratio: null, band: 'none' })).toBe('No use');
		expect(useLabel(null)).toBe('No whole year');
		expect(useSentence('Farm A', { modelledM3: 1320, registeredM3: 1000, ratio: 1.32, band: 'over' }, 'the mean water year')).toBe(
			`Farm A: 132 % of registered, ${fmtNum(1320)} m³ modelled against ${fmtNum(1000)} m³ registered (the mean water year). 10–50 % more.`
		);
	});

	it('a dam beside the river: its surface use is the take at the intake, and the sentence says so (engine 1.82.0)', () => {
		const c = compareAllocations({
			startDate: '2001-10-01',
			nodes: [{ nodeId: 'E', name: 'Farm E', kind: 'farm', supplied: new Array(365).fill(50), intakeTake: new Array(365).fill(100) }],
			allocations: [{ id: 'e', nodeId: 'E', waterSource: 'surface', volumeM3PerYear: 36_500 }]
		});
		const u = unitUse(c.nodes[0]!, 'surface', null)!;
		expect(u).toMatchObject({ modelledM3: 36_500, atIntake: true, band: 'near' });
		expect(useSentence('Farm E', u, 'the mean water year')).toMatch(/m³ modelled \(taken at the intake\) against/);
		expect(unitUse(c.nodes[0]!, 'groundwater', null)?.atIntake).toBeUndefined();
	});
});

describe('useShading: units on the map, and the ones without a polygon', () => {
	it('draws units with a polygon, lists the rest with their band, and outlines a polygon whose unit the run lacks', () => {
		const features = [
			parcel('pa', 'A', 0),
			parcel('pa2', 'A', 5, 3, 3e6),
			parcel('pb', 'B', 1),
			parcel('pc', 'C', 2),
			parcel('pz', 'Z', 3),
			// Not a unit's polygon: a dam, an unlinked parcel.
			parcel('dam', 'D', 4, 1, 1e6, 'dam'),
			parcel('free', null, 6)
		];
		const s = useShading(comparison(), features, 'surface', null);
		expect(s.drawn.map((u) => [u.nodeId, u.band, u.label])).toEqual([
			['A', 'over', '130 %'],
			['B', 'over', '125 %'],
			['C', 'none', 'No use']
		]);
		// A's label sits in its larger polygon.
		expect(s.drawn[0]!.polygons.map((p) => p.featureId)).toEqual(['pa2', 'pa']);
		expect(s.drawn[0]!.at![0]).toBeGreaterThan(5);
		// D has no parcel (the dam is not its polygon): listed, with its band.
		expect(s.unplaced.map((u) => [u.nodeId, u.band])).toEqual([['D', 'unregistered']]);
		expect(s.notInRun.map((u) => [u.nodeId, u.name])).toEqual([['Z', 'Unit Z']]);

		const data = useMapData(s);
		expect(data.features.map((f) => [f.properties.nodeId, f.properties.band])).toEqual([
			['A', 'over'],
			['A', 'over'],
			['B', 'over'],
			['C', 'none'],
			['Z', 'notinrun']
		]);
		expect(useBounds(s)).toEqual([
			[0, 0],
			[8, 1]
		]);
	});

	it('a picked year the run covers only in part shades nothing: every unit reads "No whole year"', () => {
		const s = useShading(comparison(), [parcel('pa', 'A', 0)], 'surface', 2003);
		expect(s.drawn[0]).toMatchObject({ band: null, label: 'No whole year' });
		expect(useMapData(s).features[0]!.properties.band).toBe('nodata');
	});

	it('the list under the map is in the order to look into first', () => {
		const s = useShading(comparison(), [], 'groundwater', null);
		expect(s.drawn).toEqual([]);
		expect(s.unplaced.map((u) => [u.nodeId, u.band])).toEqual([
			['B', 'far'],
			['A', 'none'],
			['C', 'none'],
			['D', 'none']
		]);
	});
});

/** Relative luminance and contrast ratio (WCAG 2.2). */
const lum = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
	return (x + 0.05) / (y + 0.05);
};

describe('the bands’ colours', () => {
	for (const dark of [false, true])
		it(`${dark ? 'dark' : 'light'}: each label reads on its band at 4.5:1, and no two bands share a colour`, () => {
			const c = bandColours(dark);
			for (const b of USE_BANDS) expect(contrast(c[b].text, c[b].fill), `${b} label`).toBeGreaterThanOrEqual(4.5);
			expect(new Set(USE_BANDS.map((b) => c[b].fill)).size).toBe(USE_BANDS.length);
			// The two reds, side by side in the legend: the bright one is darker (light theme) or more saturated, never the same.
			expect(contrast(c.over.fill, c.far.fill)).toBeGreaterThan(1.3);
		});

	it('the layers fill the four ratio bands, hatch the unregistered one and only outline the rest', () => {
		const layers = useLayers(false);
		expect(layers.map((l) => l.id)).toEqual(['use-fill', 'use-unregistered', 'use-hatch', 'use-casing', 'use-line', 'use-line-dashed']);
		expect(JSON.stringify(layers.find((l) => l.id === 'use-fill')!.filter)).toBe(JSON.stringify(['in', ['get', 'band'], ['literal', ['under', 'near', 'over', 'far']]]));
		expect((layers.find((l) => l.id === 'use-hatch')!.paint as Record<string, unknown>)['fill-pattern']).toBe('use-hatch');
	});

	it('the hatching tiles seamlessly: stripes on the diagonal, transparent between', () => {
		const { width, height, data } = hatchPixels(false, 8);
		expect([width, height, data.length]).toEqual([8, 8, 256]);
		const on = (x: number, y: number) => data[(y * 8 + x) * 4 + 3] === 255;
		expect(on(0, 0)).toBe(true);
		expect(on(1, 0)).toBe(false);
		// The pattern's right edge meets its left edge: column 7 continues column -1.
		for (let y = 0; y < 8; y++) expect(on(7, y)).toBe(on(7 - 4, y));
	});
});
