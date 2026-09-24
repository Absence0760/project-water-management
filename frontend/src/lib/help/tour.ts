// The /help landing tour: eight stops on the illustrated catchment
// (static/help/catchment-*.webp), following the water from rain to the
// outlet. Each stop's position on the picture comes from
// ./catchment-hotspots.json, which bin/gen-help-art.sh writes from the same
// Blender camera that rendered it, so a stop always sits on its feature.
// Text uses the guides' inline markup (see ./guides.ts `inline`).

import hotspots from './catchment-hotspots.json';

export type TourStopId = keyof typeof hotspots.spots;

export interface TourStop {
	id: TourStopId;
	title: string;
	text: string;
	/** The guide that explains this part in full. */
	guide: string;
}

export const TOUR: TourStop[] = [
	{
		id: 'rain',
		title: 'Rain falls on the catchment',
		text: 'Daily rain drives everything. Each day uses the catchment’s own rain record; gaps are filled with bias-corrected [[chirps|CHIRPS]] satellite rain.',
		guide: 'rain-gap-filling'
	},
	{
		id: 'evaporation',
		title: 'Some of it evaporates',
		text: 'Monthly [[apan|A-pan evaporation]] sets how much the sun can take back: scaled by the [[pan-coefficient]] for the runoff model, and by [[crop-factor|crop factors]] for irrigation demand.',
		guide: 'how-gr4j-works'
	},
	{
		id: 'runoff',
		title: 'The land turns rain into flow',
		text: 'The [[runoff-model]] (GR4J by default) holds rain in the soil and releases it over days. What comes out is the [[natural-flow]]: the river as it would be with no farms.',
		guide: 'how-gr4j-works'
	},
	{
		id: 'dam',
		title: 'Farm dams catch part of it',
		text: 'Each farm gets a fixed [[flow-share|share]] of the natural flow. Its dam captures some of that and of the water from upstream, up to its [[dam-capacity|capacity]]; the rest passes below or [[spill|spills]].',
		guide: 'a-day-on-a-farm'
	},
	{
		id: 'irrigation',
		title: 'Crops are irrigated from the dams',
		text: 'Crop areas, A-pan and crop factors give each farm’s [[irrigation-demand]], less the rain that falls on the crops. The dam supplies what it can; the rest is a [[irrigation-deficit|deficit]].',
		guide: 'set-up-crops-and-demand'
	},
	{
		id: 'transfer',
		title: 'Pipelines move water between dams',
		text: 'A [[transfer]] takes water from one farm’s dam to another in chosen months, up to the pipe’s capacity, keeping a minimum in the source dam.',
		guide: 'add-a-transfer'
	},
	{
		id: 'river',
		title: 'The river must keep its Reserve',
		text: 'What leaves each farm flows on downstream. Every day the model checks whether enough stays in the river for the [[ewr|ecological Reserve (EWR)]], and which farm causes a shortfall.',
		guide: 'set-the-ewr'
	},
	{
		id: 'outlet',
		title: 'The outlet is measured',
		text: 'The weir gauge measures the real river. The model’s simulated outflow is scored against it to [[calibration|calibrate]] the runoff model, and judged on days the fit never saw.',
		guide: 'how-calibration-works'
	}
];

export const TOUR_SPOTS = hotspots.spots;
export const TOUR_IMAGE = { width: hotspots.width, height: hotspots.height };
