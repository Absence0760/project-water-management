// The planted-areas drawer's "From land cover" section (issue #326
// B-landcover; docs/ui.md § Farm drawer, docs/maps.md § Cultivated area from
// land cover): the areas a unit's parcels offer (all of them summed, or one
// parcel), and per crop what the unit holds now, where an accepted area came
// from, and whether the chosen area is already what it holds. The land cover
// says where land is cultivated, never what grows there: the modeller picks
// the crop, one value at a time.
//
// Beside the land cover, the crop-type grid (SANLC, issue #604 R5-D; docs/maps.md
// § Orchards and vines from SANLC) offers each parcel's orchards and vines as
// areas too, and shows what is new since its earlier edition for a licence
// applicant (never an area to use).
import type { CropAreaFromLandCover, CroplandProposals, CropTypeAreas, CropTypeLayer } from '#lib/api/index.js';
import { fmtDate, fmtNum } from '#lib/format/number.js';

/** An area in hectares, as the Crops page writes planted areas. */
export const fmtHa = (m2: number) => `${fmtNum(m2 / 10_000, 2, true)} ha`;

/** One area the modeller can use: the unit's parcels together, or one parcel; cultivated land, or (with `layer`) its orchards or vines. */
export interface AreaChoice {
	/** 'unit', or the parcel's feature id; prefixed `orchard:` or `vine:` for a crop-type layer. */
	key: string;
	featureId: string | null;
	label: string;
	areaM2: number;
	/** Null: the land cover's cultivated area; else the crop-type grid's layer (its dataset in `dataset`). */
	layer: CropTypeLayer | null;
	/** The dataset label the server re-derives it from. */
	dataset: string;
}

export const LAYER_LABEL: Record<CropTypeLayer, string> = { orchard: 'Orchards', vine: 'Vines' };
const LAYER_WORDS: Record<CropTypeLayer, string> = { orchard: 'permanent orchards', vine: 'permanent vines' };

const isAreas = <T extends object>(x: T): x is T & CropTypeAreas => 'orchardM2' in x;

/** The crop-type grid's areas on offer: per layer, the unit's sum (with several parcels), then each parcel with some. */
export function cropTypeChoices(p: CroplandProposals): AreaChoice[] {
	const t = p.cropTypes;
	if (!t) return [];
	const out: AreaChoice[] = [];
	const parcels = t.parcels.filter(isAreas);
	for (const layer of ['orchard', 'vine'] as const) {
		const of = (a: CropTypeAreas) => (layer === 'orchard' ? a.orchardM2 : a.vineM2);
		if (t.unit && of(t.unit) > 0 && t.parcels.length > 1) {
			out.push({ key: `${layer}:unit`, featureId: null, label: `${LAYER_LABEL[layer]}, all ${t.parcels.length} parcels: ${fmtHa(of(t.unit))}`, areaM2: of(t.unit), layer, dataset: t.dataset.dataset });
		}
		for (const f of parcels) {
			if (!(of(f) > 0)) continue;
			const one = t.parcels.length === 1;
			out.push({
				key: `${layer}:${one ? 'unit' : f.featureId}`,
				featureId: one ? null : f.featureId,
				label: `${LAYER_LABEL[layer]}, ${f.name || 'Unnamed parcel'}: ${fmtHa(of(f))}`,
				areaM2: of(f),
				layer,
				dataset: t.dataset.dataset
			});
		}
	}
	return out;
}

/**
 * The areas on offer, the unit's sum first, then the crop-type grid's orchards and vines; none without a land-cover dataset,
 * and a parcel with no cropland (or no orchard, no vine) or no summary offers nothing.
 */
export function areaChoices(p: CroplandProposals): AreaChoice[] {
	if (!p.dataset) return [];
	const dataset = p.dataset.dataset;
	const out: AreaChoice[] = [];
	if (p.unit && p.unit.cultivatedM2 > 0 && p.parcels.length > 1) {
		out.push({ key: 'unit', featureId: null, label: `All ${p.parcels.length} parcels: ${fmtHa(p.unit.cultivatedM2)}`, areaM2: p.unit.cultivatedM2, layer: null, dataset });
	}
	for (const f of p.parcels) {
		if (!f.cultivatedM2) continue;
		out.push({
			key: p.parcels.length === 1 ? 'unit' : f.featureId,
			// With one parcel, it is the unit's area: accepted as such.
			featureId: p.parcels.length === 1 ? null : f.featureId,
			label: `${f.name || 'Unnamed parcel'}: ${fmtHa(f.cultivatedM2)}`,
			areaM2: f.cultivatedM2,
			layer: null,
			dataset
		});
	}
	return [...out, ...cropTypeChoices(p)];
}

/** Where a crop's accepted area came from, in a line. */
export function provenanceText(a: CropAreaFromLandCover): string {
	const from = a.basis === 'parcel' ? `the parcel “${a.featureName ?? ''}”` : 'the unit’s parcels';
	const when = fmtDate(a.acceptedAt);
	const what = a.layer ? `crop types (${a.layer === 'orchard' ? 'orchards' : 'vines'}; ${from}; ${a.dataset}, ${a.version})` : `land cover (${from}; ${a.dataset}, ${a.version})`;
	return a.current ? `${fmtHa(a.areaM2)} from ${what}, used ${when}` : `Typed over since: ${fmtHa(a.areaM2)} came from ${what} on ${when}`;
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

/**
 * What the proposal is and isn't (#90 Land-cover proposals): satellite cropland, dryland and fallow fields
 * included, not the irrigated area. Shown on the drawer and in the confirmation.
 */
export const CAUTION =
	'This is cultivated land mapped from satellite, including dryland and fallow fields, not the irrigated area: check it before you use it.';

/** What the crop-type proposal is and isn't: orchard and vine land from satellite, not the irrigated area, and not which fruit. */
export const CROP_TYPE_CAUTION =
	'This is orchard and vine land mapped from satellite, not the irrigated area, and it doesn’t say which fruit or cultivar: check it before you use it.';

/** The new-planting words for a parcel or the unit: orchards and vines new since the earlier edition, or null without one. */
export function newPlantingText(a: CropTypeAreas, baselineVersion: string | null): string | null {
	if (!baselineVersion) return null;
	const total = a.newOrchardM2 + a.newVineM2;
	return total > 0 ? fmtHa(total) : 'None';
}

/** The confirmation before an area is saved to the model. */
export function confirmWords(p: CroplandProposals, crop: CropRow, choice: AreaChoice): { title: string; message: string; confirmLabel: string } {
	const from = choice.featureId ? `the parcel ${choice.label.replace(/:[^:]*$/, '').replace(/^(Orchards|Vines), /, '')}` : `${p.nodeName}’s parcels`;
	if (choice.layer && p.cropTypes) {
		const t = p.cropTypes.dataset;
		return {
			title: `Set ${crop.name}’s planted area on ${p.nodeName} from crop types?`,
			message:
				`${crop.name} on ${p.nodeName} changes from ${crop.now === 'None' ? 'no planted area' : crop.now} to ${fmtHa(choice.areaM2)}, ` +
				`the ${LAYER_WORDS[choice.layer]} the crop types (${t.dataset}, ${t.version}) show in ${from}. ` +
				`${CROP_TYPE_CAUTION} ` +
				'The area is used as it stands, with no discount. The change is saved to the model now and recorded in History with its source; the next run uses it.',
			confirmLabel: 'Use this area'
		};
	}
	return {
		title: `Set ${crop.name}’s planted area on ${p.nodeName} from land cover?`,
		message:
			`${crop.name} on ${p.nodeName} changes from ${crop.now === 'None' ? 'no planted area' : crop.now} to ${fmtHa(choice.areaM2)}, ` +
			`the cultivated area the land cover (${p.dataset?.dataset}, ${p.dataset?.version}) shows in ${from}. ` +
			`${CAUTION} It doesn’t say what grows there either: check that this crop is right. ` +
			'The area is used as it stands, with no discount. The change is saved to the model now and recorded in History with its source; the next run uses it.',
		confirmLabel: 'Use this area'
	};
}
