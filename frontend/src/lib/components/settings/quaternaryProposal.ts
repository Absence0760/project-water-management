// The quaternary lookup's proposal in Settings → WR2012 check (issue #288
// phase 2, WP-3.12; docs/ui.md § Settings, docs/maps.md § Quaternary lookup):
// one row per value the quaternary at a point proposes, with what the form
// holds now. The hydrologist uses each value one by one, sees its source, and
// saves the form as usual; nothing here writes to the model. Pure, so vitest
// covers it (quaternaryProposal.test.ts).
import type { MapFeature, MapPosition, QuaternaryProposal } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import type { Wr2012Draft } from './wr2012';

export type ProposalKey = 'quaternary' | 'areaKm2' | 'mapMm' | 'marMm3' | 'period' | 'monthlyMm3' | 'source';

export interface ProposalRow {
	key: ProposalKey;
	label: string;
	now: string;
	proposed: string;
	/** The form already holds the proposed value. */
	same: boolean;
	/** The dataset has no value for it: nothing to use. */
	missing: boolean;
}

const num = (v: number | null | undefined, d: number) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : fmtNum(v, d));
const close = (a: number | null | undefined, b: number | null | undefined) => a !== null && a !== undefined && b !== null && b !== undefined && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const months = (m: readonly (number | null)[] | null | undefined) => (m && m.some((v) => v !== null) ? m.map((v) => (v === null ? '–' : fmtNum(v, 3))).join(' · ') : '–');

/** The source as the form keeps it: the dataset's own, plus the quaternary and the point it was looked up at. */
export function proposedSource(p: QuaternaryProposal, at: MapPosition): string {
	return `${p.source} (quaternary ${p.code}, looked up on the map at ${fmtNum(at[1], 4)}, ${fmtNum(at[0], 4)})`.slice(0, 500);
}

/** Every row the proposal has, in the form's order. */
export function proposalRows(ref: Wr2012Draft, p: QuaternaryProposal, at: MapPosition): ProposalRow[] {
	const period = (a: number | null, b: number | null) => (a === null || b === null ? '–' : `${a}/${String((a + 1) % 100).padStart(2, '0')} to ${b}/${String((b + 1) % 100).padStart(2, '0')}`);
	const src = proposedSource(p, at);
	return [
		{ key: 'quaternary', label: 'Quaternary catchment', now: ref.quaternary || '–', proposed: p.code, same: ref.quaternary === p.code, missing: false },
		{ key: 'areaKm2', label: 'Quaternary area (km²)', now: num(ref.areaKm2, 1), proposed: num(p.areaKm2, 1), same: close(ref.areaKm2, p.areaKm2), missing: p.areaKm2 === null },
		{ key: 'mapMm', label: 'Quaternary MAP (mm)', now: num(ref.mapMm, 0), proposed: num(p.mapMm, 0), same: close(ref.mapMm, p.mapMm), missing: p.mapMm === null },
		{ key: 'marMm3', label: 'Naturalised MAR (Mm³/a)', now: num(ref.marMm3, 3), proposed: num(p.marMm3, 3), same: close(ref.marMm3, p.marMm3), missing: p.marMm3 === null },
		{
			key: 'period',
			label: 'Reference period (water years)',
			now: period(ref.periodStart, ref.periodEnd),
			proposed: period(p.periodStart, p.periodEnd),
			same: ref.periodStart === p.periodStart && ref.periodEnd === p.periodEnd,
			missing: p.periodStart === null || p.periodEnd === null
		},
		{
			key: 'monthlyMm3',
			label: 'Monthly means, Oct … Sep (Mm³)',
			now: months(ref.monthlyMm3),
			proposed: months(p.monthlyMm3),
			same: !!p.monthlyMm3 && p.monthlyMm3.every((v, i) => close(ref.monthlyMm3[i], v)),
			missing: !p.monthlyMm3
		},
		{ key: 'source', label: 'Source', now: ref.source || '–', proposed: src, same: ref.source === src, missing: false }
	];
}

/** Put one proposed value into the form's draft (the person's explicit choice; the form still needs saving). */
export function useValue(ref: Wr2012Draft, p: QuaternaryProposal, key: ProposalKey, at: MapPosition): void {
	switch (key) {
		case 'quaternary':
			ref.quaternary = p.code;
			break;
		case 'areaKm2':
			if (p.areaKm2 !== null) ref.areaKm2 = p.areaKm2;
			break;
		case 'mapMm':
			if (p.mapMm !== null) ref.mapMm = p.mapMm;
			break;
		case 'marMm3':
			if (p.marMm3 !== null) ref.marMm3 = p.marMm3;
			break;
		case 'period':
			if (p.periodStart !== null && p.periodEnd !== null) {
				ref.periodStart = p.periodStart;
				ref.periodEnd = p.periodEnd;
			}
			break;
		case 'monthlyMm3':
			if (p.monthlyMm3) ref.monthlyMm3 = [...p.monthlyMm3];
			break;
		case 'source':
			ref.source = proposedSource(p, at);
			break;
	}
}

export interface LookupPoint {
	id: string;
	label: string;
	at: MapPosition;
}

/** The points the lookup can start from: the catchment boundary's centre, then each gauge on the map. */
export function lookupPoints(features: readonly MapFeature[]): LookupPoint[] {
	const out: LookupPoint[] = [];
	const b = features.find((f) => f.kind === 'catchment_boundary');
	if (b) out.push({ id: b.id, label: `The catchment boundary’s centre${b.name ? ` (${b.name})` : ''}`, at: b.center });
	for (const g of features.filter((f) => f.kind === 'gauge')) out.push({ id: g.id, label: `Gauge ${g.name || g.nodeName || ''}`.trim(), at: g.center });
	return out;
}
