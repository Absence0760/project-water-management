// The farm view's words (category 'farmer'): whole entries, shown on
// /farm/words and in the /help glossary's last topic. Their own module so a
// farmer's words page loads these eight and not the whole glossary, and so
// scripts/guards/i18n_sheet.mjs can load them with Node's type stripping.
// Their Afrikaans is in content.af.ts. No HelpTip points at them (they have
// no `fields`; content.test.ts checks).

import type { HelpEntry } from './types';

export const FARMER_HELP: HelpEntry[] = [
	// ---- Words on your farm page (the farmer view, WP-2.6) -------------------
	// Written for farmers, not hydrologists (docs/design/farmer-view.md §5.1):
	// the farm pages link here from "What do these words mean?".
	{
		id: 'farm-even-share',
		term: 'Even share',
		short: 'The share of what they needed that hydrological units across the catchment received. A fairness check, not water you are owed.',
		long: 'Add up what every hydrological unit in the catchment needed, and what they all received. The even share is the second as a part of the first: if it is 89 %, hydrological units together received 89 % of what they needed.\n\nYour hydrological unit page puts your own figure next to it, so you can see whether you did a little better or worse than the catchment as a whole. It is a fairness check, not extra water for you: whether more water can reach your hydrological unit depends on where you are on the river and what is in your dam.\n\nIt is only shown when there are enough hydrological units in the catchment that it can’t reveal a neighbour’s figures.',
		category: 'farmer',
		aliases: ['gelyke deel', 'fair share'],
		related: ['farm-pump-less', 'farm-reserve'],
		source: 'docs/design/farmer-view.md §5.3; docs/model.md §2.11'
	},
	{
		id: 'farm-reserve',
		term: 'The river’s reserve',
		short: 'Water the law keeps in the river so it stays healthy for everyone downstream.',
		long: 'South African law sets aside some water in every river: the Ecological Reserve. The model checks, day by day, whether the river kept that much water at the outlet and at the measuring points below your hydrological unit that are checked for the reserve.\n\nOn days it didn’t, the hydrological units upstream are asked to make it up, each in proportion to the water it used up or stored. Water that flows back to the river doesn’t count against you. On some days the river was low only because of low rain; those days ask nothing of anyone.',
		category: 'farmer',
		aliases: ['die rivier se reserwe', 'ecological reserve'],
		related: ['farm-pump-less', 'ewr'],
		source: 'National Water Act (Act 36 of 1998) s16–18; docs/design/farmer-view.md §5.1'
	},
	{
		id: 'farm-pump-less',
		term: 'Pump less (for the river)',
		short: 'How much less you would have pumped on the days the river needed water, so it kept its reserve.',
		long: 'Your hydrological unit page gives this per day the river needed it, not averaged over the whole season: cutting a little every day does little on the days that matter.\n\nIf your dam also held back water the river needed, the page says so separately. That part isn’t taken off your pumping; if your dam has an outlet or a bypass, letting that water through helps.\n\nThis is the model’s estimate. Only a notice from your WUA or from DWS is a restriction.',
		category: 'farmer',
		aliases: ['pomp minder'],
		related: ['farm-reserve', 'farm-model-band'],
		source: 'docs/design/farmer-view.md §5.2'
	},
	{
		id: 'farm-modelled',
		term: 'Modelled (worked out by the model)',
		short: 'Worked out by a computer model of the catchment from rain, river flow and crops, not read from a meter or gauge.',
		long: 'Nobody measures your dam or your pump for this page. The model works out every day how much rain fell, how much water flowed down the river to your hydrological unit, what your crops needed and what your dam held.\n\nIt can be wrong. If your meter or gauge plate reads very differently, tell your WUA: it helps them correct the model.',
		category: 'farmer',
		aliases: ['deur die model bereken', 'estimate'],
		related: ['farm-needed', 'farm-stop-level'],
		source: 'docs/design/farmer-view.md §5.1'
	},
	{
		id: 'farm-needed',
		term: 'Water you needed',
		short: 'What your hydrological unit would have to pump for its crops: what the crops use, allowing for the water lost on the way.',
		long: 'Crops need a certain amount of water each day, less what the rain gives them. Not all the water you pump reaches the crop: some is lost to wind, evaporation and run-off. The model allows for that with your irrigation system’s efficiency (drip about 90 %, micro or centre pivot 85 %, sprinklers 75 %, flood 65 %).\n\nSo "needed" is what you would have to pump, the quantity your meter shows. If the page names the wrong irrigation system for your hydrological unit, tell your WUA.',
		category: 'farmer',
		related: ['farm-modelled'],
		source: 'docs/design/farmer-view.md §3 Q1; docs/model.md §2.7; docs/engine-audit.md N1'
	},
	{
		id: 'farm-stop-level',
		term: 'Stop level',
		short: 'The dam level where irrigation stops: your pump intake, or water you keep back. The model won’t irrigate below it.',
		long: '"You can still use" is the water in your dam above this level. The days-left line divides it by what you used over the last 14 days, as a rough guide if nothing flows in.\n\nIf the page says the model assumes your pump can empty the dam, no stop level is set for your hydrological unit yet: tell your WUA the level your pump stops at.',
		category: 'farmer',
		related: ['farm-modelled'],
		source: 'docs/design/farmer-view.md §3 Q3; docs/model.md §2.7'
	},
	{
		id: 'farm-model-band',
		term: 'Model: OK, watch or short',
		short: 'The model’s own rating of your season so far. Not a restriction: only a notice from your WUA or from DWS is one.',
		long: 'OK: you would have had at least 90 % of the water you needed after pumping less for the river. Watch: 70 to 90 %, or your dam held back water the river needed. Short: under 70 %.\n\nThese thresholds are a proposal the WUA may change.',
		category: 'farmer',
		related: ['farm-pump-less'],
		source: 'docs/design/farmer-view.md §6.2 (FV-D1)'
	},
	{
		id: 'farm-saved-copy',
		term: 'The copy kept on your phone',
		short: 'Your hydrological unit’s last figures, kept on this phone so they show at once and when there is no signal.',
		long: 'It holds only your own hydrological unit’s figures, which you may see anyway. It is removed when you sign out, when someone else signs in on this phone, when you no longer have access to the hydrological unit, and when it hasn’t been opened for 30 days.\n\nOn a phone you share, choose "Don’t keep a copy on this phone" in the Menu.',
		category: 'farmer',
		source: 'docs/design/farmer-view.md §9'
	},
	{
		id: 'farm-wua',
		term: 'WUA (Water User Association)',
		short: 'The body of water users that manages water use in your area. It publishes the figures on this page, and its own notices.',
		long: 'A Water User Association (WUA) is a body of the water users in an area, set up under the National Water Act. It manages how water is shared among its members, and it issues the notices that tell farmers to use less water. Some areas still have an irrigation board instead, which does the same job until it becomes a WUA.\n\nThe figures on your hydrological unit page are the ones your WUA published. Only a notice from your WUA or from the Department of Water and Sanitation (DWS) is a restriction. Ask your WUA if anything on the page is unclear.',
		category: 'farmer',
		aliases: ['WGV', 'watergebruikersvereniging', 'irrigation board', 'besproeiingsraad'],
		related: ['farm-modelled', 'farm-model-band'],
		source: 'National Water Act (Act 36 of 1998) ch 8; s98 (irrigation boards)'
	}
];
