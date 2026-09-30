// Where calibration scores the model (engine ≥ 1.41.0, docs/model.md §2.10k):
// the outlet (settings.calibrationSiteNodeId null, every engine before), or a
// gauge node inside the network with an observed record of its own
// (084_gauge_records.sql, a GaugeSeriesKey series). Pure: the node list and
// the series are all it reads.
import { calibrationRecordsAt, type CalibrationFlowKind, type ProjectModel } from '../project';

/** A gauge calibration can be scored at: an inner gauge with at least one observed record. */
export interface CalibrationSite {
	nodeId: string;
	name: string;
	/** Its records, in CALIBRATION_FLOW_KINDS order (never empty). */
	records: CalibrationFlowKind[];
}

/**
 * The gauges inside the network (a gauge node that drains into another node)
 * with an observed record attached, in node-name order (then id): what
 * Settings → Calibration record offers besides the outlet.
 */
export function calibrationSites(model: Pick<ProjectModel, 'nodes'>, series: Readonly<Record<string, unknown>> | undefined): CalibrationSite[] {
	return model.nodes
		.filter((n) => n.kind === 'gauge' && n.downstreamNodeId !== null)
		.map((n) => ({ nodeId: n.id, name: n.name, records: calibrationRecordsAt(series, n.id) }))
		.filter((s) => s.records.length > 0)
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

/**
 * Why a calibration site can't be used, or null: the node is gone, isn't a
 * gauge, or is the outlet (whose records are the ones with no site). A site
 * without a record is the caller's to refuse, since it depends on the flow
 * kind wanted.
 */
export function calibrationSiteError(nodes: ProjectModel['nodes'], outflow: number, siteNodeId: string): string | null {
	const i = nodes.findIndex((n) => n.id === siteNodeId);
	if (i < 0) return 'the calibration site is no longer in the model: pick a gauge, or the outlet, in Settings → Calibration record';
	const n = nodes[i]!;
	if (n.kind !== 'gauge') return `the calibration site "${n.name}" is not a gauge: pick a gauge, or the outlet, in Settings → Calibration record`;
	if (i === outflow) return `the calibration site "${n.name}" is the outlet: leave the site at the outlet, whose records are the ones with no site`;
	return null;
}

/**
 * The node index calibration scores at: `outflow` for the outlet (null), else
 * the gauge's. Throws when the gauge can't be used (calibrationSiteError).
 */
export function calibrationSiteIndex(nodes: ProjectModel['nodes'], outflow: number, siteNodeId: string | null): number {
	if (siteNodeId === null) return outflow;
	const err = calibrationSiteError(nodes, outflow, siteNodeId);
	if (err) throw new Error(err);
	return nodes.findIndex((n) => n.id === siteNodeId);
}
