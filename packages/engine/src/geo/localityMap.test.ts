// The locality map's drawing (issue #326 A5; docs/evidence-pack.md § The
// locality map): the projection's scale, the scale bar and coordinate ticks,
// escaping, and determinism. The fixture's bytes are pinned by their SHA-256:
// a change to what the figure writes must bump LOCALITY_MAP_VERSION (packs
// record the version, and reproduce:pack compares the SVG's hash).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { degreeLabel, escapeXml, LOCALITY_MAP_VERSION, localityMapSvg, localProjection, niceScaleBar, tickStep, ticksIn, type LocalityMapData } from './localityMap';

const box = (lon: number, lat: number, d: number): [number, number][] => [
	[lon, lat],
	[lon + d, lat],
	[lon + d, lat + d],
	[lon, lat + d],
	[lon, lat]
];

/** An invented catchment near 33.7° S, 21.3° E: boundary, two parcels, a dam, a river, a gauge and an EWR site. */
const FIXTURE: LocalityMapData = {
	version: LOCALITY_MAP_VERSION,
	applicant: true,
	features: [
		{ layer: 'boundary', label: null, geometry: { type: 'Polygon', coordinates: [box(21.3, -33.7, 0.1)] } },
		{ layer: 'parcel', label: null, geometry: { type: 'Polygon', coordinates: [box(21.36, -33.66, 0.02)] } },
		{ layer: 'applicantParcel', label: 'Upper farm', geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.03)] } },
		{ layer: 'applicantDam', label: null, geometry: { type: 'Point', coordinates: [21.325, -33.675] } },
		{ layer: 'river', label: null, geometry: { type: 'LineString', coordinates: [[21.305, -33.605], [21.35, -33.65], [21.395, -33.695]] } },
		{ layer: 'gauge', label: 'Gauge X1', geometry: { type: 'Point', coordinates: [21.35, -33.65] } },
		{ layer: 'ewrSite', label: 'Reserve site', geometry: { type: 'Point', coordinates: [21.39, -33.69] } }
	],
	asOf: '2026-09-30',
	sources: [{ fileName: 'synthetic.geojson', sha256: 'a'.repeat(64), importedAt: '2026-09-29' }],
	drawnInApp: 2,
	svgSha256: null
};

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('localProjection', () => {
	it('scales a degree by the WGS84 radii at its latitude: the textbook series gives 110 916 m of latitude and 92 762 m of longitude at 33.65° S', () => {
		// 111132.954 − 559.822 cos 2φ + 1.175 cos 4φ, and 111412.84 cos φ − 93.5 cos 3φ + 0.118 cos 5φ.
		const p = localProjection(21.35, -33.65);
		expect(p.mPerDegLat).toBeCloseTo(110_916.09, 0);
		expect(p.mPerDegLon).toBeCloseTo(92_761.93, -1);
		expect(p.project([21.35, -33.65])).toEqual([0, 0]);
		const [x, y] = p.project([21.36, -33.64]);
		expect(x).toBeCloseTo(927.62, 1);
		expect(y).toBeCloseTo(1109.16, 1);
	});

	it('at the equator a degree of longitude is the ellipsoid’s 111.32 km', () => {
		expect(localProjection(0, 0).mPerDegLon).toBeCloseTo(111_319.5, 0);
	});
});

describe('the scale bar and ticks', () => {
	it('takes the longest 1, 2 or 5 × 10ⁿ that fits, in m under 1 km', () => {
		expect(niceScaleBar(2_400)).toEqual({ metres: 2_000, label: '2 km' });
		expect(niceScaleBar(4_999)).toEqual({ metres: 2_000, label: '2 km' });
		expect(niceScaleBar(5_000)).toEqual({ metres: 5_000, label: '5 km' });
		expect(niceScaleBar(999)).toEqual({ metres: 500, label: '500 m' });
		expect(niceScaleBar(130)).toEqual({ metres: 100, label: '100 m' });
		expect(niceScaleBar(19_000)).toEqual({ metres: 10_000, label: '10 km' });
		expect(niceScaleBar(0)).toEqual({ metres: 1, label: '1 m' });
	});

	it('the bar drawn is that length at the figure’s scale', () => {
		const fig = localityMapSvg(FIXTURE);
		// The extent is 0.1° × 0.1°, padded 12 %: 0.112° of longitude across the map.
		const p = localProjection(21.35, -33.65);
		const mapMetres = 0.112 * p.mPerDegLon;
		expect(fig.scaleBar).toEqual(niceScaleBar(mapMetres / 4));
		expect(fig.scaleBar.label).toBe('2 km');
		// Two half bars, together the bar's length in px.
		const halves = [...fig.svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="5"/g)].map((m) => Number(m[1]));
		expect(halves).toHaveLength(2);
		const mapPx = Number(/<clipPath id="frame"><rect x="[\d.]+" y="[\d.]+" width="(\d+)"/.exec(fig.svg)![1]);
		expect(halves[0]! + halves[1]!).toBeCloseTo((2_000 / mapMetres) * mapPx, 0);
	});

	it('ticks at exact multiples of a step giving at most five', () => {
		expect(tickStep(0.112)).toBe(0.05);
		expect(tickStep(0.6)).toBe(0.2);
		expect(tickStep(3)).toBe(1);
		expect(ticksIn(21.294, 21.406, 0.05)).toEqual([21.3, 21.35, 21.4]);
		expect(ticksIn(-33.706, -33.594, 0.05)).toEqual([-33.7, -33.65, -33.6]);
		expect(ticksIn(0.29, 0.61, 0.1)).toEqual([0.3, 0.4, 0.5, 0.6]);
		expect(degreeLabel(-33.65, 'lat', 0.05)).toBe('33.65° S');
		expect(degreeLabel(21.3, 'lon', 0.05)).toBe('21.30° E');
		expect(degreeLabel(-0.0001, 'lon', 0.1)).toBe('0.0°');
	});
});

describe('localityMapSvg', () => {
	it('gives the same string for the same data, and its bytes are pinned (a change bumps LOCALITY_MAP_VERSION)', () => {
		const a = localityMapSvg(FIXTURE);
		const b = localityMapSvg(structuredClone(FIXTURE));
		expect(b.svg).toBe(a.svg);
		// Through JSON (as a manifest stores it) too.
		expect(localityMapSvg(JSON.parse(JSON.stringify(FIXTURE)) as LocalityMapData).svg).toBe(a.svg);
		expect(LOCALITY_MAP_VERSION).toBe('locality-1');
		expect(sha(a.svg)).toMatchInlineSnapshot(`"197560d6022c47a1fed945ee75b2c2d55029cd6e2ff24a1465c6d6e17a3086c9"`);
	});

	it('draws the features in layer order whatever order they come in', () => {
		const shuffled = { ...FIXTURE, features: [...FIXTURE.features].reverse() };
		expect(localityMapSvg(shuffled).svg).toBe(localityMapSvg(FIXTURE).svg);
	});

	it('prints the legend, labels, north arrow, scale, ticks and the notes as text', () => {
		const fig = localityMapSvg(FIXTURE);
		expect(fig.legend.map((e) => e.label)).toEqual([
			'Catchment boundary',
			'Other units’ parcels (not named)',
			'The applicant’s unit (parcel)',
			'The applicant’s dam',
			'River',
			'Gauge',
			'EWR site (its Reserve is assessed in § 1)'
		]);
		for (const e of fig.legend) expect(fig.svg).toContain(`>${escapeXml(e.label)}</text>`);
		expect(fig.labels).toEqual(['Upper farm', 'Gauge X1', 'Reserve site']);
		expect(fig.notes[0]).toBe('Base: the project’s map features; no basemap.');
		expect(fig.notes[1]).toBe('Features as of 2026-09-30: 5 imported from 1 file, 2 drawn in the app.');
		expect(fig.notes[2]).toBe('Projection: local equirectangular about 33.650° S, 21.350° E (WGS84), true to scale at that latitude.');
		for (const n of fig.notes) expect(fig.svg).toContain(escapeXml(n));
		expect(fig.svg).toContain('aria-label="North"');
		expect(fig.svg).toContain('>21.30° E</text>');
		expect(fig.svg).toContain('>33.70° S</text>');
		// No basemap, no external reference of any kind.
		expect(fig.svg).not.toMatch(/href|<image|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
	});

	it('a baseline figure has no applicant: the parcels are just the units’', () => {
		const fig = localityMapSvg({ ...FIXTURE, applicant: false, features: FIXTURE.features.filter((f) => f.layer !== 'applicantParcel' && f.layer !== 'applicantDam') });
		expect(fig.legend.map((e) => e.label)).toContain('Units’ parcels');
		expect(fig.svg).not.toContain('applicant');
	});

	it('never labels another unit’s parcel or dam, even when the data names it', () => {
		const fig = localityMapSvg({ ...FIXTURE, features: [...FIXTURE.features, { layer: 'parcel', label: 'Neighbour farm', geometry: { type: 'Polygon', coordinates: [box(21.33, -33.63, 0.01)] } }] });
		expect(fig.svg).not.toContain('Neighbour farm');
		expect(fig.labels).not.toContain('Neighbour farm');
	});

	it('escapes a label’s markup, so a name can’t add elements', () => {
		const fig = localityMapSvg({ ...FIXTURE, features: [{ layer: 'gauge', label: '<script>alert(1)</script> & "x"', geometry: { type: 'Point', coordinates: [21.3, -33.7] } }] });
		expect(fig.svg).not.toContain('<script');
		expect(fig.svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
	});

	it('frames a lone point at least 2 km across, and refuses data with no feature', () => {
		const fig = localityMapSvg({ ...FIXTURE, features: [{ layer: 'gauge', label: null, geometry: { type: 'Point', coordinates: [21.3, -33.7] } }] });
		expect(fig.scaleBar.metres).toBeGreaterThanOrEqual(200);
		expect(fig.svg).not.toContain('NaN');
		expect(() => localityMapSvg({ ...FIXTURE, features: [] })).toThrow(/at least one feature/);
	});

	it('writes no "-0.0" and no NaN', () => {
		const svg = localityMapSvg(FIXTURE).svg;
		expect(svg).not.toMatch(/-0\.0\b|NaN|Infinity/);
	});
});
