// The help illustrations: shots of one Blender scene (static/help/<shot>-<w>.webp,
// rendered by bin/gen-help-art.sh from scripts/help-art/catchment.py) and,
// for each shot, where its labelled features sit on the picture
// (./pictures.json, written by the same render, so markers always land on
// their features). Each shot is served at its full width and half of it.

import pictures from './pictures.json';

export type ShotId = keyof typeof pictures;
export type Spot = { x: number; y: number };
export interface Shot {
	width: number;
	height: number;
	spots: Record<string, Spot>;
}

export const SHOTS = pictures as Record<ShotId, Shot>;

/** What each shot shows, for its alt text. */
export const SHOT_ALT: Record<ShotId, string> = {
	catchment:
		'An illustrated catchment, cut out of the ground like a block with soil and groundwater layers on its sides. Rain falls from clouds over the mountains at the back, with the sun beside them. A river runs down the valley to a weir and gauging hut at the front edge; a tributary from the left passes through a farm dam. A pipeline carries water from that dam across the river to a second dam. An orchard and a vineyard are irrigated from the dams, and there is a farmhouse near the river.',
	farm: 'Close-up of one farm: a stream flows into a farm dam with a curved wall on its downstream side, a thin irrigation pipe runs from the dam to an orchard, a transfer pipeline on piers leaves the dam, and the stream continues below the wall.',
	weir: 'Close-up of the catchment outlet: a low concrete weir across the river at the edge of the block, with a small gauging hut beside it and the river reach above it.',
	soil: 'Close-up of the block’s cut face beside the river: a thin band of topsoil, a thicker moist soil zone, groundwater below it and bedrock at the bottom; the river channel is cut into the surface at the top.',
	transfer: 'Close-up of a transfer pipeline on low piers crossing the river between two farm dams.',
	river: 'Close-up of a reach of the river, lined with trees, running through farmland.'
};

export function pictureSrc(shot: ShotId, width: number = SHOTS[shot].width): string {
	return `/help/${shot}-${width}.webp`;
}

/** srcset for a shot: its half and full width. */
export function pictureSrcset(shot: ShotId, base = ''): string {
	const w = SHOTS[shot].width;
	return `${base}${pictureSrc(shot, w / 2)} ${w / 2}w, ${base}${pictureSrc(shot, w)} ${w}w`;
}

/** Help tips (ⓘ) for these glossary entries show a close-up of that part of the scene. */
export const TIP_PICTURES: Record<string, ShotId> = {
	// one farm and its dam
	'element-farm': 'farm',
	'dam-capacity': 'farm',
	'dam-initial': 'farm',
	'dam-min': 'farm',
	'dam-storage': 'farm',
	spill: 'farm',
	'upstream-to-dam': 'farm',
	'runoff-to-dam': 'farm',
	diversion: 'farm',
	'return-flow': 'farm',
	'farm-runoff': 'farm',
	'farm-outflow': 'farm',
	'upstream-inflow': 'farm',
	'crop-area': 'farm',
	'irrigation-demand': 'farm',
	'irrigation-supplied': 'farm',
	'irrigation-deficit': 'farm',
	// the outlet
	'outflow-gauge': 'weir',
	'element-gauge': 'weir',
	'observed-flow': 'weir',
	'calibration-window': 'weir',
	'gauge-logger-agreement': 'weir',
	// under the ground
	'runoff-model': 'soil',
	gr4j: 'soil',
	'actual-evaporation': 'soil',
	'pan-coefficient': 'soil',
	'base-flow': 'soil',
	'natural-flow': 'soil',
	// the pipeline
	transfer: 'transfer',
	'transfer-months': 'transfer',
	'transfer-rate': 'transfer',
	'transfer-min-storage': 'transfer',
	// the river
	ewr: 'river',
	'pragmatic-ewr': 'river',
	'ewr-shortfall': 'river',
	'ewr-days-not-met': 'river',
	'ewr-share': 'river',
	// the whole catchment
	network: 'catchment',
	'water-balance': 'catchment',
	'rain-catchment': 'catchment'
};
