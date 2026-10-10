// The Data tab's Series details row (issue #464): under the chart, the picked
// series' Product, Measured at, Source and Upload unit, each with a visible
// label. Until then the product and where a flow record was measured were
// small unlabelled selects stacked in the row's name cell, and the source sat
// apart under the chart. The table row keeps a read-only "At gauge X".
import type { SeriesMeta } from '@water-management/engine';
import { asksFreeProvenance, asksProvenance, seriesProvenance } from '$lib/series/provenance';
import { SITED_KINDS } from './roles';

type Gauge = { id: string; name: string };

/** How the product shows: a CHIRPS select (editors), the words, or not at all. */
export function productField(s: Pick<SeriesMeta, 'kind' | 'product' | 'productVersion'>): 'chirps' | 'text' | null {
	if (asksProvenance(s.kind)) return 'chirps';
	return asksFreeProvenance(s.kind) && seriesProvenance(s) ? 'text' : null;
}

/** Whether a series has a Measured at: a flow record, when the model has a gauge above the outlet or the record is still placed at one. */
export const asksSite = (s: Pick<SeriesMeta, 'kind' | 'siteNodeId'>, gauges: readonly Gauge[]) =>
	SITED_KINDS.has(s.kind) && (gauges.length > 0 || !!s.siteNodeId);

/** Where a flow record was measured, as an option and a value read out: "The outlet", "Gauge Middle weir". */
export function siteText(siteNodeId: string | null | undefined, gauges: readonly Gauge[]): string {
	if (!siteNodeId) return 'The outlet';
	const g = gauges.find((x) => x.id === siteNodeId);
	return g ? `Gauge ${g.name}` : 'A hydrological unit no longer in the model';
}

/** The row's read-only mark for a record placed at a gauge ("At gauge Middle weir"); null at the outlet, which needs no line. */
export function rowSiteMark(s: Pick<SeriesMeta, 'kind' | 'siteNodeId'>, gauges: readonly Gauge[]): string | null {
	if (!SITED_KINDS.has(s.kind) || !s.siteNodeId) return null;
	const g = gauges.find((x) => x.id === s.siteNodeId);
	return g ? `At gauge ${g.name}` : 'At a hydrological unit no longer in the model';
}

/** The unit a series was uploaded in, and the conversion when there was one: "l/s, converted to m³/s (× 0.001)". */
export function uploadUnitText(s: Pick<SeriesMeta, 'unit' | 'sourceUnit' | 'sourceUnitFactor'>): string {
	if (!s.sourceUnit) return 'Not recorded';
	return s.sourceUnitFactor != null && s.sourceUnitFactor !== 1 ? `${s.sourceUnit}, converted to ${s.unit} (× ${s.sourceUnitFactor})` : s.sourceUnit;
}
