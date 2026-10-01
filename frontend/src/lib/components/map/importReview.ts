// The upload sheet's review table (issue #326 D2; docs/maps.md § Uploads,
// docs/ui.md § Map): each feature of a file with the kind the server
// proposed, editable with its name and the node it stands for, and what
// stops the import. Pure, so vitest covers it (importReview.test.ts). The
// server checks everything again on import: this only keeps the table from
// offering a choice it would refuse.
import type { MapFeatureKind, MapGeometry, MapImportPreview, MapImportPreviewFeature, MapImportProblem, MapImportReviewed } from '$lib/api/types';
import { KIND_LABEL, KIND_NODES } from './mapData';

/** The geometry types each kind may have (backend geo/geojson.ts KIND_GEOMETRY). */
export const KIND_GEOMETRY: Record<MapFeatureKind, readonly MapGeometry['type'][]> = {
	catchment_boundary: ['Polygon', 'MultiPolygon'],
	farm_parcel: ['Polygon', 'MultiPolygon'],
	dam: ['Point', 'Polygon', 'MultiPolygon'],
	gauge: ['Point'],
	river: ['LineString', 'MultiLineString'],
	other: ['Point', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']
};

/** The kinds in the review's order. */
export const REVIEW_KINDS = Object.keys(KIND_LABEL) as MapFeatureKind[];

/** One row of the review, as the editor leaves it. A refused feature (no geometry) has no kind and is never sent. */
export interface ReviewRow {
	index: number;
	geometryType: MapGeometry['type'] | null;
	areaM2: number | null;
	name: string;
	kind: MapFeatureKind | null;
	kindFrom: MapImportPreviewFeature['kindFrom'];
	note?: string;
	nodeId: string | null;
}

export type ReviewNode = MapImportPreview['nodes'][number];

export const reviewRows = (p: MapImportPreview): ReviewRow[] =>
	p.features.map((f) => ({ index: f.index, geometryType: f.geometryType, areaM2: f.areaM2, name: f.name, kind: f.kind, kindFrom: f.kindFrom, ...(f.note ? { note: f.note } : {}), nodeId: f.nodeId }));

/** The kinds a row may be: those that fit its geometry. */
export const kindsFor = (r: Pick<ReviewRow, 'geometryType'>): MapFeatureKind[] => (r.geometryType ? REVIEW_KINDS.filter((k) => KIND_GEOMETRY[k].includes(r.geometryType!)) : []);

/** The nodes a feature of `kind` may stand for. */
export const nodesFor = (kind: MapFeatureKind | null, nodes: readonly ReviewNode[]): ReviewNode[] => (kind ? nodes.filter((n) => KIND_NODES[kind].includes(n.kind)) : []);

/** A row given another kind: its node kept only when it can still stand for it. */
export function withKind(r: ReviewRow, kind: MapFeatureKind, nodes: readonly ReviewNode[]): ReviewRow {
	const keep = r.nodeId !== null && nodesFor(kind, nodes).some((n) => n.id === r.nodeId);
	return { ...r, kind, nodeId: keep ? r.nodeId : null };
}

/**
 * "Set every row's kind": each row whose geometry can be `kind` takes it; the
 * others keep theirs. Returns the rows and how many couldn't take it.
 */
export function setEveryKind(rows: readonly ReviewRow[], kind: MapFeatureKind, nodes: readonly ReviewNode[]): { rows: ReviewRow[]; skipped: number } {
	let skipped = 0;
	const out = rows.map((r) => {
		if (!r.geometryType) return r;
		if (!KIND_GEOMETRY[kind].includes(r.geometryType)) {
			skipped++;
			return r;
		}
		return withKind(r, kind, nodes);
	});
	return { rows: out, skipped };
}

/** What stops the import as the rows stand, besides the file's own problems: a file holds at most one boundary. */
export function reviewProblems(rows: readonly ReviewRow[]): MapImportProblem[] {
	const boundaries = rows.filter((r) => r.kind === 'catchment_boundary').map((r) => r.index);
	return boundaries.length > 1 ? [{ feature: null, message: `A file holds at most one catchment boundary; features ${boundaries.join(', ')} are each marked as one.` }] : [];
}

/** The review would replace the project's current boundary: a row is marked as the boundary and the project has one. */
export const replacesBoundary = (rows: readonly ReviewRow[], current: MapImportPreview['currentBoundary']): boolean =>
	current !== null && rows.some((r) => r.kind === 'catchment_boundary');

/** The warning over the table while the review replaces the boundary. */
export const replaceBoundaryText = (current: { name: string }): string =>
	`Importing replaces the current catchment boundary${current.name.trim() ? ` “${current.name.trim()}”` : ''}: it goes from the map.`;

/**
 * The import's body from the review: every row, and `replaceBoundary` only
 * while the rows replace the boundary and the editor ticked it (the server
 * refuses a replacing import without it).
 */
export function importBody(rows: readonly ReviewRow[], current: MapImportPreview['currentBoundary'], replaceTicked: boolean): { features: MapImportReviewed[]; replaceBoundary?: true } {
	const features = reviewedFeatures(rows);
	return replacesBoundary(rows, current) && replaceTicked ? { features, replaceBoundary: true } : { features };
}

/** The body's `features`: every row, with its kind, name and node. */
export const reviewedFeatures = (rows: readonly ReviewRow[]): MapImportReviewed[] =>
	rows.flatMap((r) => (r.kind ? [{ index: r.index, kind: r.kind, name: r.name.trim(), nodeId: KIND_NODES[r.kind].length ? r.nodeId : null }] : []));

/** How many rows of each kind, in the review's order: "2 farm parcels, 1 river". */
export function kindCounts(rows: readonly ReviewRow[]): string {
	const n = new Map<MapFeatureKind, number>();
	for (const r of rows) if (r.kind) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
	return REVIEW_KINDS.filter((k) => n.has(k))
		.map((k) => {
			const c = n.get(k)!;
			const label = KIND_LABEL[k].toLowerCase();
			return `${c} ${c === 1 ? label : k === 'catchment_boundary' ? 'catchment boundaries' : `${label}s`}`;
		})
		.join(', ');
}
