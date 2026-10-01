// The site locality map (issue #326 A5): a figure of the catchment's map
// features (the boundary, the units' parcels and dams, rivers, gauges and EWR
// sites) drawn as one SVG string, with a scale bar, a north arrow, coordinate
// ticks, a legend and the features' date. An evidence pack prints it in § 1
// (docs/evidence-pack.md § The locality map), and anything else that wants a
// plain locality figure can import it.
//
// Deterministic by construction, so a pack's manifest can name the SVG's
// SHA-256 and `pnpm reproduce:pack` can draw it again and compare: no
// basemap, tiles, fonts files, clocks or randomness; a fixed projection (a
// local equirectangular one about the extent's centre, on the WGS84
// ellipsoid's local radii); every coordinate written with one decimal; the
// same features in the same order give the same string. Pure: no DOM, no I/O.
//
// Any change to what localityMapSvg writes for the same data bumps
// LOCALITY_MAP_VERSION: a pack records the version its SVG was drawn with, and
// localityMap.test.ts pins the bytes of a fixture so a change can't slip by.

/** The figure's drawing rules. Bump on any change to the SVG written for the same data. */
export const LOCALITY_MAP_VERSION = 'locality-1';

export type LocalityPosition = [number, number];
export type LocalityGeometry =
	| { type: 'Point'; coordinates: LocalityPosition }
	| { type: 'LineString'; coordinates: LocalityPosition[] }
	| { type: 'MultiLineString'; coordinates: LocalityPosition[][] }
	| { type: 'Polygon'; coordinates: LocalityPosition[][] }
	| { type: 'MultiPolygon'; coordinates: LocalityPosition[][][] };

/**
 * What a feature is on the figure. `applicantParcel` and `applicantDam` are the
 * application's own units'; `parcel` and `dam` everyone else's, drawn alike and
 * never named; `ewrSite` a gauge that is a Reserve site of the report.
 */
export type LocalityLayer = 'boundary' | 'parcel' | 'dam' | 'applicantParcel' | 'applicantDam' | 'river' | 'gauge' | 'ewrSite';

export interface LocalityFeature {
	layer: LocalityLayer;
	/** Printed beside it: the applicant's unit, a gauge or an EWR site; null = no label (always null for another unit's parcel or dam). */
	label: string | null;
	geometry: LocalityGeometry;
}

/** An imported GeoJSON file some of the features came from (152 geo_source). */
export interface LocalitySource {
	fileName: string;
	sha256: string;
	/** YYYY-MM-DD. */
	importedAt: string;
}

/** What the figure is drawn from: an evidence report's `localityMap` (evidence-12). */
export interface LocalityMapData {
	version: typeof LOCALITY_MAP_VERSION;
	/** An application's figure names the applicant's units and calls the rest "other"; a baseline's has no applicant. */
	applicant: boolean;
	/** In drawing order (boundary first, points last). Coordinates WGS84 lon/lat, 6 decimals. */
	features: LocalityFeature[];
	/** The newest change to any feature drawn, YYYY-MM-DD. */
	asOf: string;
	sources: LocalitySource[];
	/** Features drawn in the app rather than imported. */
	drawnInApp: number;
	/** SHA-256 of localityMapSvg(this).svg, set by whoever builds the report (the engine has no hash); null when not set. */
	svgSha256: string | null;
}

export interface LocalityLegendEntry {
	layer: LocalityLayer;
	label: string;
}

export interface LocalityFigure {
	svg: string;
	width: number;
	height: number;
	/** The legend, as the SVG prints it, for a text copy beside the figure. */
	legend: LocalityLegendEntry[];
	/** The notes under the legend (base, date, sources, projection), as the SVG prints them. */
	notes: string[];
	/** The labelled features, as the SVG prints them. */
	labels: string[];
	scaleBar: { metres: number; label: string };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const DEG = Math.PI / 180;

export interface LocalProjection {
	lon0: number;
	lat0: number;
	/** Metres per degree of longitude and of latitude at lat0. */
	mPerDegLon: number;
	mPerDegLat: number;
	/** [lon, lat] → [x east, y north], metres from the centre. */
	project: (p: LocalityPosition) => [number, number];
}

/**
 * A local equirectangular projection about (lon0, lat0): x and y in metres
 * from the centre, scaled by the WGS84 ellipsoid's meridional and
 * prime-vertical radii at lat0. North is up. True to scale at lat0; at a
 * catchment's size (tens of kilometres) the east–west scale drifts by
 * cos(lat)/cos(lat0), well under 1 % within ±0.5° of latitude.
 */
export function localProjection(lon0: number, lat0: number): LocalProjection {
	const s = Math.sin(lat0 * DEG);
	const w = 1 - WGS84_E2 * s * s;
	const meridional = (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w));
	const primeVertical = WGS84_A / Math.sqrt(w);
	const mPerDegLat = meridional * DEG;
	const mPerDegLon = primeVertical * Math.cos(lat0 * DEG) * DEG;
	return { lon0, lat0, mPerDegLon, mPerDegLat, project: ([lon, lat]) => [(lon - lon0) * mPerDegLon, (lat - lat0) * mPerDegLat] };
}

/** Every position of a geometry. */
export function positionsOf(g: LocalityGeometry): LocalityPosition[] {
	switch (g.type) {
		case 'Point':
			return [g.coordinates];
		case 'LineString':
			return g.coordinates;
		case 'MultiLineString':
		case 'Polygon':
			return g.coordinates.flat();
		case 'MultiPolygon':
			return g.coordinates.flat(2);
	}
}

export interface LonLatBox {
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

/** The box around every position of the features; null when there are none. */
export function boxOf(features: readonly { geometry: LocalityGeometry }[]): LonLatBox | null {
	let box: LonLatBox | null = null;
	for (const f of features)
		for (const [lon, lat] of positionsOf(f.geometry)) {
			if (!box) box = { minLon: lon, minLat: lat, maxLon: lon, maxLat: lat };
			else {
				if (lon < box.minLon) box.minLon = lon;
				if (lon > box.maxLon) box.maxLon = lon;
				if (lat < box.minLat) box.minLat = lat;
				if (lat > box.maxLat) box.maxLat = lat;
			}
		}
	return box;
}

// ---------------------------------------------------------------------------
// Scale bar and coordinate ticks
// ---------------------------------------------------------------------------

/**
 * The scale bar: the longest 1, 2 or 5 × 10ⁿ metres that fits in `maxMetres`
 * (a quarter of the map's width), labelled in m below 1 km, else km.
 */
export function niceScaleBar(maxMetres: number): { metres: number; label: string } {
	if (!(maxMetres >= 1)) return { metres: 1, label: '1 m' };
	const p = 10 ** Math.floor(Math.log10(maxMetres));
	const metres = [5, 2, 1].map((k) => k * p).find((m) => m <= maxMetres) ?? p;
	return { metres, label: metres >= 1000 ? `${metres / 1000} km` : `${metres} m` };
}

/** Steps a coordinate tick may take, degrees. */
const TICK_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];

/** The tick step for a span of degrees: the smallest that gives at most 5 ticks. */
export function tickStep(spanDeg: number): number {
	return TICK_STEPS.find((s) => spanDeg / s <= 5) ?? 10;
}

/** The ticks of a step inside [lo, hi], as exact multiples of it. */
export function ticksIn(lo: number, hi: number, step: number): number[] {
	const out: number[] = [];
	// Integer multiples, so 0.1 × 3 doesn't drift into 0.30000000000000004.
	const scale = Math.round(1 / Math.min(step, 1)) * 1000;
	const k = Math.round(step * scale);
	for (let i = Math.ceil((lo * scale) / k); i * k <= hi * scale; i++) out.push((i * k) / scale);
	return out;
}

const decimalsOf = (step: number) => (step >= 1 ? 0 : step >= 0.1 ? (step === 0.25 ? 2 : 1) : step >= 0.01 ? 2 : 3);

/** "33.80° S", "18.9° E": hemispheres by letter, decimals by the tick step. */
export function degreeLabel(value: number, axis: 'lat' | 'lon', step: number): string {
	const d = decimalsOf(step);
	const abs = Math.abs(value);
	const text = abs.toFixed(d);
	const zero = Number(text) === 0;
	const hemi = zero ? '' : axis === 'lat' ? (value < 0 ? ' S' : ' N') : value < 0 ? ' W' : ' E';
	return `${text}°${hemi}`;
}

// ---------------------------------------------------------------------------
// The SVG
// ---------------------------------------------------------------------------

/** One decimal, never "-0.0". */
const f1 = (n: number) => {
	const t = (Math.round(n * 10) / 10).toFixed(1);
	return t === '-0.0' ? '0.0' : t;
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text and attribute values: every markup character escaped, and control characters dropped. */
export const escapeXml = (s: string) =>
	s
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Fixed colours: the figure is printed on white and hashed, so it can't follow the app's theme. Every layer also differs by line, shape or label. */
const STYLE: Record<LocalityLayer, string> = {
	boundary: 'fill="none" stroke="#1f2937" stroke-width="1.6" stroke-dasharray="6 3"',
	parcel: 'fill="#d1d5db" fill-opacity="0.6" stroke="#6b7280" stroke-width="0.6"',
	dam: 'fill="#93c5fd" stroke="#1d4ed8" stroke-width="0.6"',
	applicantParcel: 'fill="#fcd34d" fill-opacity="0.75" stroke="#92400e" stroke-width="1.8"',
	applicantDam: 'fill="#60a5fa" stroke="#92400e" stroke-width="1.8"',
	river: 'fill="none" stroke="#2563eb" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"',
	gauge: 'fill="#ffffff" stroke="#111827" stroke-width="1.4"',
	ewrSite: 'fill="#047857" stroke="#022c22" stroke-width="1"'
};

/** Drawing order, and the legend's. */
export const LOCALITY_LAYER_ORDER: readonly LocalityLayer[] = ['boundary', 'parcel', 'dam', 'applicantParcel', 'applicantDam', 'river', 'gauge', 'ewrSite'];

export function legendLabel(layer: LocalityLayer, applicant: boolean): string {
	switch (layer) {
		case 'boundary':
			return 'Catchment boundary';
		case 'parcel':
			return applicant ? 'Other units’ parcels (not named)' : 'Units’ parcels';
		case 'dam':
			return applicant ? 'Other dams (not named)' : 'Dams';
		case 'applicantParcel':
			return 'The applicant’s unit (parcel)';
		case 'applicantDam':
			return 'The applicant’s dam';
		case 'river':
			return 'River';
		case 'gauge':
			return 'Gauge';
		case 'ewrSite':
			return 'EWR site (its Reserve is assessed in § 1)';
	}
}

/** The figure's layout, px. */
const MAP_MAX_W = 640;
const MAP_MAX_H = 520;
const LEFT = 76;
const TOP = 12;
const RIGHT = 16;
const MIN_WIDTH = 560;
const LINE = 16;
/** Smallest extent drawn, metres: a lone point still gets a readable frame. */
const MIN_EXTENT_M = 2_000;

/** Markers for points. */
function marker(layer: LocalityLayer, x: number, y: number): string {
	const s = STYLE[layer];
	if (layer === 'ewrSite') return `<path d="M${f1(x)} ${f1(y - 6)}L${f1(x + 6)} ${f1(y)}L${f1(x)} ${f1(y + 6)}L${f1(x - 6)} ${f1(y)}Z" ${s}/>`;
	if (layer === 'gauge') return `<circle cx="${f1(x)}" cy="${f1(y)}" r="4.5" ${s}/>`;
	// A point dam: a square.
	return `<rect x="${f1(x - 4)}" y="${f1(y - 4)}" width="8" height="8" ${s}/>`;
}

/** A legend swatch at (x, y), its top-left, 22 × 12. */
function swatch(layer: LocalityLayer, x: number, y: number): string {
	switch (layer) {
		case 'boundary':
		case 'river':
			return `<path d="M${f1(x)} ${f1(y + 6)}H${f1(x + 22)}" ${STYLE[layer]}/>`;
		case 'gauge':
		case 'ewrSite':
			return marker(layer, x + 11, y + 6);
		default:
			return `<rect x="${f1(x + 2)}" y="${f1(y)}" width="18" height="12" ${STYLE[layer]}/>`;
	}
}

/** Where a feature's label goes: a point itself, else the middle of its box. */
function labelAt(g: LocalityGeometry, xy: (p: LocalityPosition) => [number, number]): [number, number] {
	if (g.type === 'Point') return xy(g.coordinates);
	const pts = positionsOf(g).map(xy);
	let [minX, minY] = pts[0]!;
	let [maxX, maxY] = pts[0]!;
	for (const [x, y] of pts) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * Draw the locality map. The same data always gives the same string (the
 * pack's manifest names its SHA-256). Throws only on data with no feature.
 */
export function localityMapSvg(data: LocalityMapData): LocalityFigure {
	const features = [...data.features].sort((a, b) => LOCALITY_LAYER_ORDER.indexOf(a.layer) - LOCALITY_LAYER_ORDER.indexOf(b.layer));
	const box = boxOf(features);
	if (!box) throw new Error('a locality map needs at least one feature');

	// The extent, in metres about its centre, padded by 6 % (and at least MIN_EXTENT_M across).
	const proj = localProjection((box.minLon + box.maxLon) / 2, (box.minLat + box.maxLat) / 2);
	const [x0, y0] = proj.project([box.minLon, box.minLat]);
	const [x1, y1] = proj.project([box.maxLon, box.maxLat]);
	const halfW = Math.max((x1 - x0) * 0.56, MIN_EXTENT_M / 2);
	const halfH = Math.max((y1 - y0) * 0.56, MIN_EXTENT_M / 2);
	const scale = Math.min(MAP_MAX_W / (2 * halfW), MAP_MAX_H / (2 * halfH)); // px per metre
	const mapW = Math.round(2 * halfW * scale);
	const mapH = Math.round(2 * halfH * scale);
	const width = Math.max(LEFT + mapW + RIGHT, MIN_WIDTH);
	const left = LEFT;
	const xy = (p: LocalityPosition): [number, number] => {
		const [x, y] = proj.project(p);
		return [left + mapW / 2 + x * scale, TOP + mapH / 2 - y * scale];
	};
	const pt = (p: LocalityPosition) => {
		const [x, y] = xy(p);
		return `${f1(x)} ${f1(y)}`;
	};
	const line = (ps: readonly LocalityPosition[]) => ps.map((p, i) => `${i ? 'L' : 'M'}${pt(p)}`).join('');
	const ring = (ps: readonly LocalityPosition[]) => `${line(ps)}Z`;

	const out: string[] = [];
	const body: string[] = [];
	const labels: string[] = [];
	const labelSvg: string[] = [];

	// Coordinate ticks and a light graticule, in degrees.
	const lonLo = proj.lon0 - halfW / proj.mPerDegLon;
	const lonHi = proj.lon0 + halfW / proj.mPerDegLon;
	const latLo = proj.lat0 - halfH / proj.mPerDegLat;
	const latHi = proj.lat0 + halfH / proj.mPerDegLat;
	const step = tickStep(Math.max(lonHi - lonLo, latHi - latLo));
	const grid: string[] = [];
	const tickText: string[] = [];
	for (const lon of ticksIn(lonLo, lonHi, step)) {
		const [x] = xy([lon, proj.lat0]);
		grid.push(`M${f1(x)} ${f1(TOP)}V${f1(TOP + mapH)}`);
		tickText.push(`<text x="${f1(x)}" y="${f1(TOP + mapH + 14)}" text-anchor="middle">${escapeXml(degreeLabel(lon, 'lon', step))}</text>`);
	}
	for (const lat of ticksIn(latLo, latHi, step)) {
		const [, y] = xy([proj.lon0, lat]);
		grid.push(`M${f1(left)} ${f1(y)}H${f1(left + mapW)}`);
		tickText.push(`<text x="${f1(left - 6)}" y="${f1(y + 4)}" text-anchor="end">${escapeXml(degreeLabel(lat, 'lat', step))}</text>`);
	}

	for (const f of features) {
		const g = f.geometry;
		const s = STYLE[f.layer];
		switch (g.type) {
			case 'Point':
				body.push(marker(f.layer, ...xy(g.coordinates)));
				break;
			case 'LineString':
				body.push(`<path d="${line(g.coordinates)}" ${s}/>`);
				break;
			case 'MultiLineString':
				body.push(`<path d="${g.coordinates.map(line).join('')}" ${s}/>`);
				break;
			case 'Polygon':
				body.push(`<path d="${g.coordinates.map(ring).join('')}" fill-rule="evenodd" ${s}/>`);
				break;
			case 'MultiPolygon':
				body.push(`<path d="${g.coordinates.flatMap((p) => p.map(ring)).join('')}" fill-rule="evenodd" ${s}/>`);
				break;
		}
		const isOther = f.layer === 'parcel' || f.layer === 'dam';
		if (f.label && !isOther) {
			const [lx, ly] = labelAt(g, xy);
			labels.push(f.label);
			// Kept inside the frame: a label's width is estimated (no font metrics here), 6.5 px a character at 11 px bold.
			const w = f.label.length * 6.5;
			const right = left + mapW - 4;
			let at: string;
			if (g.type === 'Point') at = lx + 8 + w <= right ? `x="${f1(lx + 8)}"` : `x="${f1(lx - 8)}" text-anchor="end"`;
			else at = `x="${f1(Math.max(left + 4 + w / 2, Math.min(right - w / 2, lx)))}" text-anchor="middle"`;
			labelSvg.push(`<text ${at} y="${f1(ly + 4)}" class="lbl">${escapeXml(f.label)}</text>`);
		}
	}

	// North arrow, top right inside the frame.
	const nx = left + mapW - 18;
	const ny = TOP + 10;
	const north = `<g aria-label="North"><path d="M${f1(nx)} ${f1(ny)}L${f1(nx + 6)} ${f1(ny + 16)}L${f1(nx)} ${f1(ny + 12)}L${f1(nx - 6)} ${f1(ny + 16)}Z" fill="#111827"/><text x="${f1(nx)}" y="${f1(ny + 28)}" text-anchor="middle" class="b">N</text></g>`;

	// Scale bar under the frame, a quarter of the map's width at most.
	const bar = niceScaleBar((mapW / 4) / scale);
	const barPx = bar.metres * scale;
	const by = TOP + mapH + 26;
	const scaleSvg = [
		`<rect x="${f1(left)}" y="${f1(by)}" width="${f1(barPx / 2)}" height="5" fill="#111827"/>`,
		`<rect x="${f1(left + barPx / 2)}" y="${f1(by)}" width="${f1(barPx / 2)}" height="5" fill="#ffffff" stroke="#111827" stroke-width="0.8"/>`,
		`<text x="${f1(left)}" y="${f1(by + 17)}" text-anchor="middle">0</text>`,
		`<text x="${f1(left + barPx)}" y="${f1(by + 17)}" text-anchor="middle">${escapeXml(bar.label)}</text>`
	].join('');

	// Legend: the layers drawn, in order, two columns.
	const present = LOCALITY_LAYER_ORDER.filter((l) => features.some((f) => f.layer === l));
	const legend = present.map((layer) => ({ layer, label: legendLabel(layer, data.applicant) }));
	const colW = Math.floor((width - left - RIGHT) / 2);
	const legendTop = by + 30;
	const legendSvg = legend.map((e, i) => {
		const x = left + (i % 2) * colW;
		const y = legendTop + Math.floor(i / 2) * LINE;
		return `${swatch(e.layer, x, y)}<text x="${f1(x + 28)}" y="${f1(y + 10)}">${escapeXml(e.label)}</text>`;
	});

	const files = data.sources.length;
	const imported = data.features.length - data.drawnInApp;
	const notes = [
		'Base: the project’s map features; no basemap.',
		`Features as of ${data.asOf}: ${[
			imported ? `${imported} imported from ${files === 1 ? '1 file' : `${files} files`}` : '',
			data.drawnInApp ? `${data.drawnInApp} drawn in the app` : ''
		]
			.filter(Boolean)
			.join(', ')}.`,
		`Projection: local equirectangular about ${degreeLabel(proj.lat0, 'lat', 0.001)}, ${degreeLabel(proj.lon0, 'lon', 0.001)} (WGS84), true to scale at that latitude.`
	];
	const notesTop = legendTop + Math.ceil(legend.length / 2) * LINE + 8;
	const notesSvg = notes.map((n, i) => `<text x="${f1(left)}" y="${f1(notesTop + i * 14 + 10)}" class="note">${escapeXml(n)}</text>`);
	const height = notesTop + notes.length * 14 + 10;

	out.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#111827">`,
		'<style>.lbl{font-size:11px;font-weight:600;paint-order:stroke;stroke:#ffffff;stroke-width:3px;stroke-linejoin:round}.b{font-weight:700}.note{font-size:10px;fill:#374151}</style>',
		`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
		`<clipPath id="frame"><rect x="${f1(left)}" y="${f1(TOP)}" width="${mapW}" height="${mapH}"/></clipPath>`,
		`<path d="${grid.join('')}" fill="none" stroke="#e5e7eb" stroke-width="0.8"/>`,
		`<g clip-path="url(#frame)">${body.join('')}${labelSvg.join('')}</g>`,
		`<rect x="${f1(left)}" y="${f1(TOP)}" width="${mapW}" height="${mapH}" fill="none" stroke="#111827" stroke-width="1"/>`,
		tickText.join(''),
		north,
		scaleSvg,
		legendSvg.join(''),
		notesSvg.join(''),
		'</svg>'
	);
	return { svg: out.join(''), width, height, legend, notes, labels, scaleBar: bar };
}
