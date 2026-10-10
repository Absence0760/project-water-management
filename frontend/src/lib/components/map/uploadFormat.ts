// The Map's GeoJSON upload's Expected format (UploadSheet, issue #456; the
// File formats help page, issue #477), with a synthetic example file.
import type { FileFormat } from '$lib/components/common/formatHelp';
import EXAMPLE_GEOJSON from './example-features.geojson?raw';

export const GEOJSON_FORMAT: FileFormat = {
	id: 'map-geojson',
	title: 'Map features (GeoJSON)',
	where: 'Map → Upload GeoJSON',
	accepts:
		'A GeoJSON file (.geojson or .json): at most 5 MB, 500 features and 50 000 positions a feature. Shapefiles and KML aren’t read: export the layer as GeoJSON in EPSG:4326 (QGIS: Export → Save Features As).',
	rules: [
		'A FeatureCollection, one Feature or one geometry: Point, LineString, MultiLineString, Polygon or MultiPolygon, in 2D.',
		'Each position is `[longitude, latitude]` in degrees, south negative. A polygon’s rings are closed and don’t cross themselves or each other.',
		'A `kind`, `type` or `layer` property proposes the feature’s kind: catchment boundary, farm parcel, dam, gauge, river or other (plurals and words such as reservoir, weir or stream too); without one, its shape does.',
		'Only a name (`name`, `label` or `title`), a description and a ref are kept; every other property is dropped.',
		'Any problem refuses the whole file, and each is listed by its feature’s place in the file (“Feature 3 …”).'
	],
	example: '{ "type": "Feature",\n  "properties": { "name": "Example weir", "kind": "gauge" },\n  "geometry": { "type": "Point", "coordinates": [21.40, -33.62] } }',
	files: [{ name: 'example-features.geojson', text: EXAMPLE_GEOJSON, type: 'application/geo+json' }]
};
