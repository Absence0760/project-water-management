// The rows of the Dams page's "Proposed from the register and the map" box
// (issue #326 B-dams; docs/ui.md § Dams, docs/maps.md § Dams from the
// register and the map): each registered dam near the unit's dam on the map
// lists its capacity for reference, and the dam polygon proposes its area as
// the full-supply area. One row per value, each with its source and what the
// saved model holds now. A unit's dam is its composite dam, the total of its
// farm dams (many unregistered), so its volume is the user's to enter: a
// registered capacity is never used for it (#523 C1; #90). Only the area is
// accepted, and the page asks first.
import type { DamProposals, RegisterDamProposal } from '#lib/api/index.js';
import { fmtNum } from '#lib/format/number.js';
import { positionText } from '#lib/components/map/mapData.js';
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

/** The confirmation before the polygon's area is saved to the model (a registered capacity is a reference only, never used). */
export function confirmWords(p: DamProposals, r: Extract<DamProposalRow, { kind: 'area' }>): { title: string; message: string; confirmLabel: string } {
	return {
		title: `Set ${p.nodeName}’s full-supply area from the map?`,
		message: `${p.current.damAreaFullM2 === null ? `${p.nodeName}’s dam has no area when full set (the run estimates one from its capacity); it becomes` : `${p.nodeName}’s dam area when full changes from ${r.now} to`} ${r.proposed}, the area of ${r.label.replace(/^Full-supply area: /, '')} computed on the server. The change is saved to the model now and recorded in History; the next run uses it for evaporation.`,
		confirmLabel: 'Use this area'
	};
}

/**
 * The folded box's line (inside the picked dam's chart panel): what is proposed for the unit's dam, so a
 * closed box still answers "is there anything to use?". "1 registered dam within 1 km (reference only) ·
 * area when full from the map 16.5 ha, not saved". `loading` and `error` are the box's load states.
 */
export function proposalsLine(p: DamProposals | null, loading: boolean, error: string | null): string {
	if (error) return 'couldn’t be loaded: open to try again';
	if (!p || loading) return 'looking up the register and the map…';
	if (!p.dam) return 'no dam on the map is linked to it';
	const km = fmtNum(p.radiusM / 1000);
	const n = p.register.length;
	const register = !p.datasets.length
		? 'no register of dams loaded'
		: n
			? `${n} registered dam${n === 1 ? '' : 's'} within ${km} km (reference only)`
			: `no registered dam within ${km} km`;
	const area = !p.area
		? 'a point on the map, so no area'
		: `area when full from the map ${fmtNum(p.area.areaM2 / 10_000, 1)} ha, ${sameValue(p.area.areaM2, p.current.damAreaFullM2) ? 'saved' : 'not saved'}`;
	return `${register} · ${area}`;
}
