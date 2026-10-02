// "Download GeoJSON" on the Map tab (issue #326 A7; docs/maps.md § Download):
// the map's features as one RFC 7946 FeatureCollection, built in the browser
// from the list the tab already loaded (no route). Data portability: the
// features go back out in the format they came in, and the file imports
// again (its `kind` property is read by the upload's review, maps.md §
// Uploads). Pure (mapExport.test.ts).
import type { MapFeature } from '$lib/api/types';
import { HYDRORIVERS_MAP_ATTRIBUTION, JRC_WATER_STATEMENT } from '$lib/components/legal/dataCredits';
import { creditedFeature } from './mapLayers';

export interface ExportedProperties {
	name: string;
	/** The feature's kind as the API names it (catchment_boundary, farm_parcel, dam, gauge, river, other). */
	kind: MapFeature['kind'];
	/** The model node it stands for, by name; null when it stands for none. */
	node: string | null;
	/** The polygon's area as the server computed it (geodesic, WGS84), km²; null for a point or a line. */
	areaKm2: number | null;
	/** The same, in hectares. */
	areaHa: number | null;
	/**
	 * The licensed data's credit, only on a feature drawn from it: a river
	 * added from HydroRIVERS (its map attribution) or a dam traced from JRC
	 * Global Surface Water (its "Source: EC JRC/Google", which the traced
	 * feature's description carries), so the credit leaves with the data
	 * (docs/maps.md § Sources). Absent on every other feature.
	 */
	credit?: string;
}

/** The credit a feature's data carries out of the app, or null (ExportedProperties.credit). */
export function featureCredit(f: Pick<MapFeature, 'kind' | 'properties'>): string | null {
	if (creditedFeature(f)) return HYDRORIVERS_MAP_ATTRIBUTION;
	const d = f.properties?.description;
	return typeof d === 'string' && d.includes(JRC_WATER_STATEMENT) ? JRC_WATER_STATEMENT : null;
}

/**
 * The features as a FeatureCollection, in WGS84 longitude/latitude (RFC 7946
 * has no `crs` member), each with its name, kind, the node it stands for and
 * its area, and a licensed source's credit where its data is drawn
 * (featureCredit). Nothing else: no ids, no file names, no user, so the
 * file says only what the map shows.
 */
export function featuresGeoJson(features: readonly MapFeature[]) {
	return {
		type: 'FeatureCollection' as const,
		features: features.map((f) => {
			const properties: ExportedProperties = {
				name: f.name,
				kind: f.kind,
				node: f.nodeName ?? null,
				areaKm2: f.areaM2 === null ? null : round(f.areaM2 / 1e6, 6),
				areaHa: f.areaM2 === null ? null : round(f.areaM2 / 1e4, 4)
			};
			const credit = featureCredit(f);
			if (credit) properties.credit = credit;
			return { type: 'Feature' as const, properties, geometry: f.geometry };
		})
	};
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** A file name from the project's name and the day: `sandspruit-map-2026-10-01.geojson` (`catchment-map-…` without a usable name). */
export function exportFileName(projectName: string | null | undefined, isoDay: string): string {
	const slug = (projectName ?? '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/, '');
	return `${slug || 'catchment'}-map-${isoDay}.geojson`;
}

/** The file's text: compact JSON (a big catchment's outlines stay small), with a final newline. */
export const geoJsonText = (features: readonly MapFeature[]) => `${JSON.stringify(featuresGeoJson(features))}\n`;
