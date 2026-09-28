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
				'A missing day should be blank, not 0: a 0 reads as a dry day and stops CHIRPS filling the gap. Long wet-season runs of zeros are the exception: by default a run treats them as missing.',
				'A large reading after dry days that CHIRPS says were wet looks like several days read at once: by default a run spreads its total over those days.'
			],
			diagram: 'rain-sources'
		}
	},
	{
		spot: 'evaporation',
		title: 'Some of it evaporates',
		text: 'Monthly [[apan|A-pan evaporation]] sets how much the sun can take back: scaled by the [[pan-coefficient]] for the GR4J runoff model, by [[crop-factor|crop factors]] for irrigation demand, and by the dam evaporation factor for the hydrological units’ dams.',
		guide: 'how-gr4j-works',
		more: {
			points: [
				'Potential evaporation = pan coefficient (0.7 by default) × A-pan, spread over the days of each month.',
				'The soil can only give up what it holds, so on dry days the [[actual-evaporation]] falls well below the potential.',
				'Dams lose [[dam-evaporation|open-water evaporation]] from their surface, which shrinks as a dam empties, and catch the rain that falls on them.'
			],
			shot: 'soil'
		}
	},
	{
		spot: 'runoff',
		title: 'The land turns rain into flow',
		text: 'The [[runoff-model]] (GR4J by default) holds rain in the soil and releases it over days. What comes out is the [[natural-flow]]: the river as it would be with no hydrological units, dams or abstraction.',
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
		title: 'Dams catch part of it',
		text: 'Each hydrological unit gets a fixed [[flow-share|share]] of the natural flow. Its dam captures some of that and of the water from upstream, up to its [[dam-capacity|capacity]]; the rest passes below or [[spill|spills]].',
		guide: 'a-day-on-a-farm',
		more: {
			points: [
				'The [[upstream-to-dam|upstream share]] and the [[runoff-to-dam|own-runoff share]] say how much enters the dam.',
				'A [[diversion]] can pump some of the water passing below back into it.',
				'Above capacity the dam spills; its outflow is the next element’s inflow.',
				'The dam also loses evaporation and any seepage, and irrigation draws only what it holds above its [[dam-min|minimum level]].',
				'Every hydrological unit’s daily balance closes to the cubic metre.'
			],
			shot: 'farm'
		}
	},
	{
		spot: 'irrigation',
		title: 'Crops are irrigated from the dams',
		text: 'Crop areas, A-pan and crop factors give each hydrological unit’s [[irrigation-demand]], less the rain that falls on the crops. The dam supplies what it can; the rest is a [[irrigation-deficit|deficit]].',
		guide: 'set-up-crops-and-demand',
		more: {
			points: [
				'Gross demand = Σ crops (area × A-pan × crop factor), spread over the days of the month.',
				'Rain above the threshold, times the effective-rain fraction, reduces the day’s demand; what the crop can’t use is kept in the [[soil-water-store|soil-water store]] for the next days.',
				'The hydrological unit abstracts the crop requirement ÷ its [[irrigation-efficiency|irrigation efficiency]]; part of the losses runs back to the river as [[return-flow|return flow]].',
				'Averaged over the run, supplied ÷ demand is the hydrological unit’s [[fraction-supplied|fraction supplied]].'
			],
			shot: 'farm'
		}
	},
	{
		spot: 'transfer',
		title: 'Pipelines move water between dams',
		text: 'A [[transfer]] takes water from one hydrological unit’s dam to another in chosen months, up to the pipe’s capacity and the room at the other end, keeping a minimum in the source dam.',
		guide: 'add-a-transfer',
		more: {
			points: [
				'Each day: the smallest of what the source dam held above its minimum yesterday, the room at the destination (free space plus that day’s demand), the rate × 86 400 s, and the daily cap.',
				'The same volume leaves one dam and enters the other, so a transfer never makes or loses water.',
				'Transfers move before any hydrological unit irrigates, lowest [[transfer-priority|priority]] first.'
			],
			shot: 'transfer'
		}
	},
	{
		spot: 'river',
		title: 'The river must keep its Reserve',
		text: 'What leaves each hydrological unit flows on downstream. Every day the model checks whether enough stays in the river for the [[ewr|ecological Reserve (EWR)]], and which hydrological units cause a shortfall.',
		guide: 'set-the-ewr',
		more: {
			points: [
				'The [[pragmatic-ewr]] is one flow per month, checked every day at the outlet and at every gauge.',
				'A shortfall is charged to the hydrological units upstream in proportion to what each took that day ([[ewr-charge]]); what they didn’t take is natural.',
				'The curtailment report works out how much each hydrological unit would reduce for irrigation to balance and the EWR to be met.'
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
