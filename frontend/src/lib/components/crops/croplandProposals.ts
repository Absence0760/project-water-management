// The planted-areas drawer's "From land cover" section (issue #326
// B-landcover; docs/ui.md § Farm drawer, docs/maps.md § Cultivated area from
// land cover): the areas a unit's parcels offer (all of them summed, or one
// parcel), and per crop what the unit holds now, where an accepted area came
// from, and whether the chosen area is already what it holds. The land cover
// says where land is cultivated, never what grows there: the modeller picks
// the crop, one value at a time.
import type { CropAreaFromLandCover, CroplandProposals } from '$lib/api';
import { fmtDate, fmtNum } from '$lib/format/number';

/** An area in hectares, as the Crops page writes planted areas. */
export const fmtHa = (m2: number) => `${fmtNum(m2 / 10_000, 2, true)} ha`;

/** One area the modeller can use: the unit's parcels together, or one parcel. */
export interface AreaChoice {
	/** 'unit', or the parcel's feature id. */
	key: string;
	featureId: string | null;
	label: string;
	areaM2: number;
}

/** The areas on offer, the unit's sum first; none without a dataset, and a parcel with no cropland or no summary offers nothing. */
export function areaChoices(p: CroplandProposals): AreaChoice[] {
	if (!p.dataset) return [];
	const out: AreaChoice[] = [];
	if (p.unit && p.unit.cultivatedM2 > 0 && p.parcels.length > 1) {
		out.push({ key: 'unit', featureId: null, label: `All ${p.parcels.length} parcels: ${fmtHa(p.unit.cultivatedM2)}`, areaM2: p.unit.cultivatedM2 });
	}
	for (const f of p.parcels) {
		if (!f.cultivatedM2) continue;
		out.push({
			key: p.parcels.length === 1 ? 'unit' : f.featureId,
			// With one parcel, it is the unit's area: accepted as such.
			featureId: p.parcels.length === 1 ? null : f.featureId,
			label: `${f.name || 'Unnamed parcel'}: ${fmtHa(f.cultivatedM2)}`,
			areaM2: f.cultivatedM2
		});
	}
	return out;
}

/** Where a crop's accepted area came from, in a line. */
export function provenanceText(a: CropAreaFromLandCover): string {
	const from = a.basis === 'parcel' ? `the parcel “${a.featureName ?? ''}”` : 'the unit’s parcels';
	const when = fmtDate(a.acceptedAt);
	return a.current
		? `${fmtHa(a.areaM2)} from land cover (${from}; ${a.dataset}, ${a.version}), used ${when}`
		: `Typed over since: ${fmtHa(a.areaM2)} came from land cover (${from}; ${a.dataset}, ${a.version}) on ${when}`;
}

export interface CropRow {
	cropId: string;
	name: string;
	now: string;
	/** The unit holds the chosen area for this crop already (to the m²). */
	same: boolean;
	provenance: string | null;
}

/** One row per crop, against the chosen area. */
export function cropRows(p: CroplandProposals, choice: AreaChoice | null): CropRow[] {
	return p.crops.map((c) => ({
		cropId: c.cropId,
		name: c.name,
		now: c.areaM2 > 0 ? fmtHa(c.areaM2) : 'None',
		same: choice !== null && Math.abs(c.areaM2 - choice.areaM2) < 0.5,
		provenance: c.accepted ? provenanceText(c.accepted) : null
	}));
}

/** The confirmation before an area is saved to the model. */
export function confirmWords(p: CroplandProposals, crop: CropRow, choice: AreaChoice): { title: string; message: string; confirmLabel: string } {
	const from = choice.featureId ? `the parcel ${choice.label.replace(/:[^:]*$/, '')}` : `${p.nodeName}’s parcels`;
	return {
		title: `Set ${crop.name}’s planted area on ${p.nodeName} from land cover?`,
		message:
			`${crop.name} on ${p.nodeName} changes from ${crop.now === 'None' ? 'no planted area' : crop.now} to ${fmtHa(choice.areaM2)}, ` +
			`the cultivated area the land cover (${p.dataset?.dataset}, ${p.dataset?.version}) shows in ${from}. ` +
			'The land cover doesn’t say what grows there or whether it is irrigated: check that this crop is right. ' +
			'The change is saved to the model now and recorded in History with its source; the next run uses it.',
		confirmLabel: 'Use this area'
	};
}
