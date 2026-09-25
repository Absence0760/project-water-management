// The /help landing tour: eight stops on the illustrated catchment (the
// `catchment` shot, ./pictures.ts), following the water from rain to the
// outlet. Each stop's `spot` is its marker in ./pictures.json. `more` opens in
// place ("Show more") with the key points and a close-up or a diagram.
// Text uses the guides' inline markup (see ./guides.ts `inline`).

import type { PictureStop } from './guides';

export const TOUR: PictureStop[] = [
	{
		spot: 'rain',
		title: 'Rain falls on the catchment',
		text: 'Daily rain drives everything. Each day uses the catchment’s own rain record; gaps are filled with bias-corrected [[chirps|CHIRPS]] satellite rain.',
		guide: 'rain-gap-filling',
		more: {
			points: [
				'Each day takes the first series with a value: catchment rain, then CHIRPS, then forecast rain.',
				'CHIRPS is scaled per calendar month by catchment ÷ CHIRPS rain, fitted on the days both have a reading.',
				'A missing day should be blank, not 0: a 0 reads as a dry day and stops CHIRPS filling the gap.'
			],
			diagram: 'rain-sources'
		}
	},
	{
		spot: 'evaporation',
		title: 'Some of it evaporates',
		text: 'Monthly [[apan|A-pan evaporation]] sets how much the sun can take back: scaled by the [[pan-coefficient]] for the runoff model, and by [[crop-factor|crop factors]] for irrigation demand.',
		guide: 'how-gr4j-works',
		more: {
			points: [
				'Potential evaporation = pan coefficient (0.7 by default) × A-pan, spread over the days of each month.',
				'The soil can only give up what it holds, so on dry days the [[actual-evaporation]] falls well below the potential.',
				'Farm dams evaporate too, from their own surface area — see [[dam-evaporation|dam evaporation]].'
			],
			shot: 'soil'
		}
	},
	{
		spot: 'runoff',
		title: 'The land turns rain into flow',
		text: 'The [[runoff-model]] (GR4J by default) holds rain in the soil and releases it over days. What comes out is the [[natural-flow]]: the river as it would be with no farms.',
		guide: 'how-gr4j-works',
		more: {
			points: [
				'GR4J keeps two stores, roughly the moist soil (X1) and the groundwater that feeds the river between storms (X3).',
				'X4 sets how many days a storm takes to reach the outlet.',
				'It conserves water: rain leaves as evaporation or flow, or stays stored.',
				'Its parameters are calibrated so the model’s outflow matches the measured river.'
			],
			shot: 'soil'
		}
	},
	{
		spot: 'dam',
		title: 'Farm dams catch part of it',
		text: 'Each farm gets a fixed [[flow-share|share]] of the natural flow. Its dam captures some of that and of the water from upstream, up to its [[dam-capacity|capacity]]; the rest passes below or [[spill|spills]].',
		guide: 'a-day-on-a-farm',
		more: {
			points: [
				'The [[upstream-to-dam|upstream share]] and the [[runoff-to-dam|own-runoff share]] say how much enters the dam.',
				'A [[diversion]] can pump some of the water passing below back into it.',
				'Above capacity the dam spills; its outflow is the next element’s inflow.',
				'Every farm’s daily balance closes to the cubic metre.'
			],
			shot: 'farm'
		}
	},
	{
		spot: 'irrigation',
		title: 'Crops are irrigated from the dams',
		text: 'Crop areas, A-pan and crop factors give each farm’s [[irrigation-demand]], less the rain that falls on the crops. The dam supplies what it can; the rest is a [[irrigation-deficit|deficit]].',
		guide: 'set-up-crops-and-demand',
		more: {
			points: [
				'Gross demand = Σ crops (area × A-pan × crop factor), spread over the days of the month.',
				'Rain above the threshold, times the effective-rain fraction, reduces the day’s demand.',
				'Part of the water applied runs back to the river as [[return-flow|return flow]].',
				'Averaged over the run, supplied ÷ demand is the farm’s [[fraction-supplied|fraction supplied]].'
			],
			shot: 'farm'
		}
	},
	{
		spot: 'transfer',
		title: 'Pipelines move water between dams',
		text: 'A [[transfer]] takes water from one farm’s dam to another in chosen months, up to the pipe’s capacity, keeping a minimum in the source dam.',
		guide: 'add-a-transfer',
		more: {
			points: [
				'Each day: the smaller of what the source dam held above its minimum yesterday, the rate × 86 400 s, and the daily cap.',
				'The same volume leaves one dam and enters the other, so a transfer never makes or loses water.',
				'Water that doesn’t fit in the receiving dam spills.'
			],
			shot: 'transfer'
		}
	},
	{
		spot: 'river',
		title: 'The river must keep its Reserve',
		text: 'What leaves each farm flows on downstream. Every day the model checks whether enough stays in the river for the [[ewr|ecological Reserve (EWR)]], and which farm causes a shortfall.',
		guide: 'set-the-ewr',
		more: {
			points: [
				'The [[pragmatic-ewr]] is one flow per month, checked every day at the outlet.',
				'Each farm carries a share of it, so the results say which farm causes a shortfall.',
				'The curtailment report works out how much each farm would reduce for irrigation to balance and the EWR to be met.'
			],
			shot: 'river'
		}
	},
	{
		spot: 'outlet',
		title: 'The outlet is measured',
		text: 'The weir gauge measures the real river. The model’s simulated outflow is scored against it to [[calibration|calibrate]] the runoff model, and judged on days the fit never saw.',
		guide: 'how-calibration-works',
		more: {
			points: [
				'Scoring uses the days with an observation inside the calibration window, less any exclusions.',
				'Fit automatically searches the parameters; validation fits one part of the record and scores another.',
				'Judge the parameters by the validation scores, not the in-sample fit.'
			],
			shot: 'weir'
		}
	}
];
