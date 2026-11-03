// The Map's upload's Expected format (UploadSheet, issue #456; the
// File formats help page, issue #477), with a synthetic example file.
import type { FileFormat } from '#lib/components/common/formatHelp.js';
import EXAMPLE_GEOJSON from './example-features.geojson?raw';

export const GEOJSON_FORMAT: FileFormat = {
	id: 'map-geojson',
	title: 'Map features (GeoJSON, KML, shapefile)',
	where: 'Map → Upload map file',
	accepts:
		'A GeoJSON file (.geojson or .json): at most 5 MB, 500 features and 50 000 positions a feature. Or a KML, a KMZ or a zipped shapefile (a .zip of the layer’s .shp, .shx, .dbf and .prj), at most 25 MB: your browser reads it into GeoJSON first, which then meets the same checks.',
	rules: [
		'A FeatureCollection, one Feature or one geometry: Point, LineString, MultiLineString, Polygon or MultiPolygon, in 2D.',
		'In GeoJSON, each position is `[longitude, latitude]` in degrees, south negative. A polygon’s rings are closed and don’t cross themselves or each other.',
		'A `kind`, `type` or `layer` property proposes the feature’s kind: catchment boundary, farm parcel, dam, gauge, river or other (plurals and words such as reservoir, weir or stream too); without one, its shape does.',
		'Only a name (`name`, `label` or `title`), a description and a ref are kept; every other property is dropped.',
		'A shapefile is reprojected to WGS84 from its .prj (a Hartebeesthoek94 Lo zone, UTM, Albers or Lambert); a zip without a .prj is refused unless its positions are already longitude and latitude. A datum with no shift to WGS84 (Cape without TOWGS84) is refused. Names come from its .dbf.',
		'A KML’s placemarks keep their name, description and ExtendedData values; altitudes are dropped, and a MultiGeometry is split into its polygons, lines and points.',
		'Any problem refuses the whole file, and each is listed by its feature’s place in the file (“Feature 3 …”).'
	],
	example: '{ "type": "Feature",\n  "properties": { "name": "Example weir", "kind": "gauge" },\n  "geometry": { "type": "Point", "coordinates": [21.40, -33.62] } }',
	files: [{ name: 'example-features.geojson', text: EXAMPLE_GEOJSON, type: 'application/geo+json' }]
};
