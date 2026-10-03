// The rows of the Dams page's "Proposed from the register and the map" box
// (issue #326 B-dams; docs/ui.md § Dams, docs/maps.md § Dams from the
// register and the map): each registered dam near the unit's dam on the map
// proposes its capacity, and the dam polygon proposes its area as the
// full-supply area. One row per value, each with its source and what the
// saved model holds now; the page accepts them one at a time.
import type { DamProposals, RegisterDamProposal } from '$lib/api';
import { fmtNum } from '$lib/format/number';
import { positionText } from '$lib/components/map/mapData';
import { fmtVolume } from './dams';

export type DamProposalRow =
	| {
			kind: 'capacity';
			/** Stable key: the register number. */
			key: string;
			registerNo: string;
			label: string;
			/** The registered dam's other facts, for reference (the model has no wall height). */
			detail: string;
			now: string;
			proposed: string;
			/** The register gives no capacity: nothing to use. */
			missing: boolean;
			/** The saved model already holds it. */
			same: boolean;
			source: string;
			synthetic: boolean;
			value: number | null;
	  }
	| {
			kind: 'area';
			key: 'area';
			featureId: string;
			label: string;
			detail: string;
			now: string;
			proposed: string;
			missing: false;
			same: boolean;
			source: string;
			synthetic: false;
			value: number;
	  };

/**
 * Where the register was searched from, with the place written as the rest of
 * the app writes one (degrees with a hemisphere, map/mapData.ts positionText):
 * "Searched from “Upper dam” (its polygon’s centre, 33.6800° S, 21.3200° E)".
 */
export function searchedFrom(dam: NonNullable<DamProposals['dam']>): string {
	const what = dam.name ? `“${dam.name}”` : 'the dam on the map';
	const how = dam.geometryType === 'Point' ? 'a point' : 'its polygon’s centre';
	return `Searched from ${what} (${how}, ${positionText(dam.point)})`;
}

/** A distance in words: "250 m", "1.2 km". */
export const fmtDistance = (m: number) => (m < 950 ? `${fmtNum(Math.round(m / 10) * 10)} m` : `${fmtNum(m / 1000, 1)} km`);
/** An area in m², with hectares beside it. */
export const fmtDamArea = (m2: number) => `${fmtNum(Math.round(m2))} m² (${fmtNum(m2 / 10_000, 1)} ha)`;

/** Equal to the nearest m³ / m²: what the server stored from the same figure. */
const sameValue = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.5;

function capacityRow(p: DamProposals, d: RegisterDamProposal): DamProposalRow {
	const facts = [
		`${fmtDistance(d.distanceM)} from the dam on the map`,
		d.wallHeightM !== null ? `wall ${fmtNum(d.wallHeightM, 1)} m` : null,
		d.completionYear !== null ? `completed ${d.completionYear}` : null,
		d.river ? `on the ${d.river}` : null,
		d.farm ? `farm ${d.farm}` : null
	].filter(Boolean);
	return {
		kind: 'capacity',
		key: d.registerNo,
		registerNo: d.registerNo,
		label: `Capacity: ${d.name} (${d.registerNo})`,
		detail: facts.join(' · '),
		now: fmtVolume(p.current.damCapacityM3),
		proposed: d.capacityM3 === null ? 'Not in the register' : fmtVolume(d.capacityM3),
		missing: d.capacityM3 === null,
		same: sameValue(d.capacityM3, p.current.damCapacityM3),
		source: `The register of dams, “${d.dataset}”: ${d.source}`,
		synthetic: d.synthetic,
		value: d.capacityM3
	};
}

/** The box's rows: the registered dams nearest first, then the polygon's area. */
export function damProposalRows(p: DamProposals): DamProposalRow[] {
	const rows: DamProposalRow[] = p.register.map((d) => capacityRow(p, d));
	if (p.area) {
		rows.push({
			kind: 'area',
			key: 'area',
			featureId: p.area.featureId,
			label: `Full-supply area: ${p.area.featureName ? `“${p.area.featureName}”` : 'the dam polygon'}`,
			detail: 'The water surface drawn on the map, when full',
			now: p.current.damAreaFullM2 === null ? 'Not set (estimated from capacity)' : fmtDamArea(p.current.damAreaFullM2),
			proposed: fmtDamArea(p.area.areaM2),
			missing: false,
			same: sameValue(p.area.areaM2, p.current.damAreaFullM2),
			source: `The map: ${p.area.method}`,
			synthetic: false,
			value: p.area.areaM2
		});
	}
	return rows;
}

/** The confirmation before a value is saved to the model. */
export function confirmWords(p: DamProposals, r: DamProposalRow): { title: string; message: string; confirmLabel: string } {
	if (r.kind === 'capacity') {
		return {
			title: `Set ${p.nodeName}’s dam capacity from the register?`,
			message: `${p.nodeName}’s dam capacity changes from ${r.now} to ${r.proposed}, the registered capacity of ${r.label.replace(/^Capacity: /, '')}. The change is saved to the model now and recorded in History with its source; the next run uses it.`,
			confirmLabel: 'Use this capacity'
		};
	}
	return {
		title: `Set ${p.nodeName}’s full-supply area from the map?`,
		message: `${p.current.damAreaFullM2 === null ? `${p.nodeName}’s dam has no area when full set (the run estimates one from its capacity); it becomes` : `${p.nodeName}’s dam area when full changes from ${r.now} to`} ${r.proposed}, the area of ${r.label.replace(/^Full-supply area: /, '')} computed on the server. The change is saved to the model now and recorded in History; the next run uses it for evaporation.`,
		confirmLabel: 'Use this area'
	};
}
