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
	river: 'Close-up of a reach of the river, lined with trees, running through farmland.',
	dam: 'Looking down onto a farm dam: a pool of stored water held by a curved concrete wall, with the stream running in at the top.',
	inflow: 'A stream running down from rainy hills into a farm dam, with the slopes around it draining towards the water.',
	spillway: 'The downstream face of a farm dam wall, with the stream leaving below it and a transfer pipeline beside it.',
	irrigation: 'A thin irrigation pipe running from a farm dam wall down across the slope to an orchard.',
	orchard: 'Close-up of an irrigated orchard: rows of fruit trees on the valley floor below a farm dam.',
	gauge: 'Close-up of the gauging hut beside the weir at the catchment outlet, where river flow is measured.'
};

export function pictureSrc(shot: ShotId, width: number = SHOTS[shot].width): string {
	return `/help/${shot}-${width}.webp`;
}

/** srcset for a shot: its half and full width. */
export function pictureSrcset(shot: ShotId, base = ''): string {
	const w = SHOTS[shot].width;
	return `${base}${pictureSrc(shot, w / 2)} ${w / 2}w, ${base}${pictureSrc(shot, w)} ${w}w`;
}

/** A help tip's picture: a close-up of the scene, with a ring on the feature the term is about. */
export interface TipPicture {
	shot: ShotId;
	/** Key of the marked feature in that shot's spots; none for a term about the whole shot. */
	spot?: string;
}

const tip = (shot: ShotId, spot?: string): TipPicture => ({ shot, spot });

/**
 * Help tips (ⓘ) for these glossary entries show a close-up of their part of
 * the scene, with their own feature ringed, so neighbouring tips don't repeat
 * one picture (guarded in tour.test.ts).
 */
export const TIP_PICTURES: Record<string, TipPicture> = {
	// one farm: the whole farm, then its dam, inflows, outflows and irrigation
	'element-farm': tip('farm'),
	'dam-capacity': tip('dam', 'storage'),
	'dam-storage': tip('dam', 'shore'),
	'dam-min': tip('dam', 'wall'),
	'dam-initial': tip('farm', 'storage'),
	spill: tip('spillway', 'spill'),
	'farm-outflow': tip('farm', 'outflow'),
	'upstream-to-dam': tip('inflow', 'upstream'),
	'runoff-to-dam': tip('inflow', 'runoff'),
	'upstream-inflow': tip('farm', 'upstream'),
	'farm-runoff': tip('farm', 'runoff'),
	diversion: tip('spillway', 'outflow'),
	'irrigation-supplied': tip('irrigation', 'pipe'),
	'irrigation-deficit': tip('irrigation', 'field'),
	'return-flow': tip('farm', 'irrigation'),
	'crop-area': tip('orchard', 'crops'),
	'irrigation-demand': tip('farm', 'crops'),
	// the outlet
	'outflow-gauge': tip('weir', 'weir'),
	'element-gauge': tip('weir', 'gauge'),
	'calibration-window': tip('gauge'),
	'observed-flow': tip('gauge', 'gauge'),
	'gauge-logger-agreement': tip('gauge', 'weir'),
	// under the ground, and the water cycle over the catchment
	'runoff-model': tip('catchment', 'runoff'),
	gr4j: tip('soil', 'soil'),
	'base-flow': tip('soil', 'groundwater'),
	'natural-flow': tip('soil', 'river'),
	'actual-evaporation': tip('soil', 'evaporation'),
	'pan-coefficient': tip('catchment', 'evaporation'),
	// the pipeline
	transfer: tip('transfer', 'pipe'),
	'transfer-rate': tip('farm', 'transfer'),
	'transfer-months': tip('catchment', 'transfer'),
	'transfer-min-storage': tip('catchment', 'dam'),
	// the river and the outlet it is judged at
	ewr: tip('river', 'river'),
	'pragmatic-ewr': tip('river'),
	'ewr-share': tip('catchment', 'river'),
	'ewr-shortfall': tip('catchment', 'outlet'),
	'ewr-days-not-met': tip('weir', 'reach'),
	// the whole catchment
	network: tip('catchment'),
	'water-balance': tip('catchment', 'rain'),
	'rain-catchment': tip('soil', 'rain')
};
