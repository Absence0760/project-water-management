// Flow records not placed in the network (issue #659, docs/ui.md § Settings &
// calibration): records no calibration location can be fitted on, which the
// Calibration page flags with a link to their Measured at on the Data page,
// and Series details says the same of. A flow record (gauge or logger) is
// unplaced when its Measured at names a node that is gone or isn't a gauge
// inside the network, or, at the outlet (no site), when another record of its
// kind is the one a run reads (the first by name, 084_gauge_records.sql,
// series/pick.ts). Pure: the series list and the nodes are all it reads.
import { CALIBRATION_FLOW_KINDS, type NetworkNode, type SeriesMeta } from '@water-management/engine';
import { firstOutletSeries } from '#lib/series/pick.js';

type Rec = Pick<SeriesMeta, 'id' | 'kind' | 'name'> & { siteNodeId?: string | null };

/** One unplaced record and why. */
export interface UnplacedRecord {
	id: string;
	name: string;
	kind: string;
	/** 'gone': its gauge is no longer in the model; 'notInner': its node isn't a gauge inside the network; 'second': a second outlet record of its kind. */
	why: 'gone' | 'notInner' | 'second';
	/** Where it says it was measured: the node's name, when it still exists. */
	at: string | null;
}

const FLOW = new Set<string>(CALIBRATION_FLOW_KINDS);

/** The project's flow records that no calibration location can be fitted on, in list order. */
export function unplacedRecords<T extends Rec>(series: readonly T[] | null | undefined, nodes: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'>[]): UnplacedRecord[] {
	if (!series) return [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const out: UnplacedRecord[] = [];
	for (const s of series) {
		if (!FLOW.has(s.kind)) continue;
		const site = s.siteNodeId ?? null;
		if (site === null) {
			if (firstOutletSeries(series, s.kind)?.id !== s.id) out.push({ id: s.id, name: s.name, kind: s.kind, why: 'second', at: null });
			continue;
		}
		const n = byId.get(site);
		if (!n) out.push({ id: s.id, name: s.name, kind: s.kind, why: 'gone', at: null });
		else if (n.kind !== 'gauge' || n.downstreamNodeId === null) out.push({ id: s.id, name: s.name, kind: s.kind, why: 'notInner', at: n.name });
	}
	return out;
}

/** Why a record isn't placed, as a clause after its name. */
export function unplacedWhy(r: Pick<UnplacedRecord, 'why' | 'at'>): string {
	if (r.why === 'gone') return 'its Measured at names a gauge no longer in the model';
	if (r.why === 'notInner') return `its Measured at is ${r.at ? `“${r.at}”, ` : ''}not a gauge inside the network`;
	return 'it is a second outlet record of its kind, and a run reads only the first by name';
}

/** The Data page's Series details of a record, where its Measured at is set. */
export const measuredAtHref = (id: string): string => `?tab=series&series=${encodeURIComponent(id)}#data-chart`;
