// § 1's locality map on the page (evidence-12, issue #326 A5): the figure as
// the engine's exact SVG bytes in a data: URL (what the PDF prints is what the
// manifest hashes), its legend and labels as text in the alt, and the two
// sentences for no map features and for a pack drafted before the figure.
import { localityMapSvg, LOCALITY_MAP_VERSION, type EvidenceReport, type LocalityMapData } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { LOCALITY_NONE, LOCALITY_NOT_IN_PACK, localityView } from './locality';

const loc: LocalityMapData = {
	version: LOCALITY_MAP_VERSION,
	applicant: true,
	features: [
		{ layer: 'boundary', label: null, geometry: { type: 'Polygon', coordinates: [[[21.3, -33.7], [21.4, -33.7], [21.4, -33.6], [21.3, -33.6], [21.3, -33.7]]] } },
		{ layer: 'applicantParcel', label: 'Upper farm', geometry: { type: 'Polygon', coordinates: [[[21.31, -33.69], [21.34, -33.69], [21.34, -33.66], [21.31, -33.66], [21.31, -33.69]]] } },
		{ layer: 'ewrSite', label: 'Reserve weir', geometry: { type: 'Point', coordinates: [21.39, -33.69] } }
	],
	asOf: '2026-09-30',
	sources: [],
	drawnInApp: 3,
	svgSha256: 'f'.repeat(64)
};
const report = (localityMap: LocalityMapData | null | undefined) => ({ mode: 'application', ...(localityMap === undefined ? {} : { localityMap }) }) as Pick<EvidenceReport, 'localityMap' | 'mode'>;

describe('localityView', () => {
	it('shows the engine’s SVG, byte for byte, as an image, with its legend and labels for the text beside it', () => {
		const v = localityView(report(loc), true);
		if (v.kind !== 'figure') throw new Error('expected a figure');
		const svg = localityMapSvg(loc).svg;
		expect(v.src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
		expect(decodeURIComponent(v.src.slice(v.src.indexOf(',') + 1))).toBe(svg);
		expect(v.svgSha256).toBe('f'.repeat(64));
		expect(v.alt).toBe('Locality map of the application, north up, drawn from the project’s map features; its legend, labels and notes follow as text.');
		expect(v.figure.legend.map((e) => e.label)).toEqual(['Catchment boundary', 'The applicant’s unit (parcel)', 'EWR site (its Reserve is assessed in § 1)']);
		expect(v.figure.labels).toEqual(['Upper farm', 'Reserve weir']);
		expect(v.figure.notes[0]).toBe('Base: the project’s map features; no basemap.');
	});

	it('says there is no locality map when the project has no map features, in a draft or a pack', () => {
		expect(localityView(report(null), false)).toEqual({ kind: 'none', text: LOCALITY_NONE });
		expect(localityView(report(null), true)).toEqual({ kind: 'none', text: LOCALITY_NONE });
		expect(LOCALITY_NONE).toBe('No locality map: the project has no map features.');
	});

	it('says a pack drafted before evidence-12 has no figure, rather than drawing one its hash doesn’t cover', () => {
		expect(localityView(report(undefined), true)).toEqual({ kind: 'none', text: LOCALITY_NOT_IN_PACK });
	});
});
