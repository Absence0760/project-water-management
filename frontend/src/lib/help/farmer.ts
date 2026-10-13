// The farm view's words (category 'farmer'): whole entries, shown on
// /farm/words and in the /help glossary's last topic. Their own module so a
// farmer's words page loads these and not the whole glossary, and so
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
	},
	{
		id: 'farm-season-outlook',
		term: 'Season outlook (This season)',
		short: 'What the irrigation level your WUA set gave your hydrological unit in past years’ weather. Not a forecast, and not a promise.',
		long: 'Before the season, the model runs the whole season from where the catchment’s dams stood on its first day, once with each past year’s rain and river flows. Your WUA looks at what several irrigation levels would give, decides on one and publishes it; the app never picks a level.\n\nThe card gives what that level gave your own hydrological unit across those past years: about how much of the water you needed you got, the range in most of the years, and how full your dam ended the season. It never shows a neighbour’s figures.\n\nThe weather this season will be its own, so your share can fall outside that range. Your WUA reviews the level on the date the card gives. Only a notice from your WUA or from DWS is a restriction.',
		category: 'farmer',
		aliases: ['seisoensvooruitsig', 'hierdie seisoen', 'this season', 'outlook'],
		related: ['farm-wua', 'farm-modelled', 'farm-needed', 'farm-forecast'],
		source: 'docs/design/planning-outputs.md §3.5; docs/model.md §2.15'
	},
	{
		id: 'farm-forecast',
		term: 'Forecast (Next 14 days)',
		short: 'What the model expects for your dam and your water in the next days, on the rain forecast. Not the season outlook, and not a promise.',
		long: 'When your WUA publishes a forecast, the model runs the coming days on the rain forecast, starting from your hydrological unit’s latest figures. The card gives the lowest level it expects your dam to reach, and around which day, and on how many of those days you may be short of water.\n\nIt is not the season outlook. The season outlook looks at the whole season in past years’ weather; the forecast looks only at the next few days, on the rain forecast for them.\n\nRain forecasts change from day to day, so look at the date the card says the forecast was made: when it is more than a few days old, the card says so first. Only a notice from your WUA or from DWS is a restriction.',
		category: 'farmer',
		aliases: ['voorspelling', 'next 14 days'],
		related: ['farm-season-outlook', 'farm-modelled', 'farm-stop-level'],
		source: 'docs/design/farmer-view.md §3 Q1 (E2); WP-2.12'
	},
	{
		id: 'farm-registered',
		term: 'Your registered water',
		short: 'The water use and dam storage registered for your hydrological unit with DWS. Not a right to that water, and not proof a use is lawful.',
		long: 'Water users register their water use with the Department of Water and Sanitation (DWS). The card shows what is registered for your hydrological unit today: the surface water and groundwater a year, and the dam storage. It shows only your own totals, never a neighbour’s, and no names or registration numbers.\n\nBeside them it puts what the model supplied this season and what your dam holds in the model when full, so you can compare. The model works out your water from rain, river flow and your crops, not from what is registered, so the two can differ.\n\nA registered volume is not an entitlement: it doesn’t give you that water, and it doesn’t say whether a use is lawful. If the registered figures look wrong, ask your WUA.',
		category: 'farmer',
		aliases: ['geregistreerde water', 'registration', 'WARMS'],
		related: ['farm-modelled', 'farm-wua', 'farm-pct-volume'],
		source: 'docs/allocations.md § Who sees what; issue #72'
	},
	{
		id: 'farm-pct-volume',
		term: 'Percent, m³ and ML',
		short: 'A percent compares two amounts, such as the water you received with what you needed. m³ and ML are amounts of water: 1 ML is 1 000 m³.',
		long: '"83 % of what you needed" means you received 83 parts for every 100 parts of water your hydrological unit needed this season. "40 % full" means your dam holds 40 parts for every 100 it holds when full.\n\nA cubic metre (m³) is 1 000 litres. A megalitre (ML) is a million litres, which is 1 000 m³. The ML and m³ buttons under "Water you received this season" switch the volumes on your hydrological unit’s pages between the two: the water is the same, only the unit changes. Your choice is saved to your account and kept on this phone; you can also change it on your account page, under Language and units.',
		category: 'farmer',
		aliases: ['persentasie', 'cubic metre', 'megalitre', 'volume unit'],
		related: ['farm-needed', 'farm-stop-level'],
		source: 'docs/ui.md § Language (volume unit); app_user.volume_unit'
	},
	{
		id: 'farm-alerts',
		term: 'Alert emails',
		short: 'Emails that tell you when the model puts your dam below the level your WUA set, or when your WUA publishes a restriction notice.',
		long: 'Your WUA decides which alerts are switched on in the catchment, and for a dam alert the level it warns at. On the Alert emails page in your account you choose, for each one, whether you get it right away, in a summary once a day at 06:00, or not at all. On a day with many alerts, only the first few come right away; the rest wait for the next morning’s summary.\n\nA dam alert is the model’s estimate, from the latest figures or from the rain forecast. It is not a restriction: only a notice from your WUA or from DWS is one.\n\nEvery alert email has a link to stop that kind of email, and one to say whether it was useful. If emails to your address bounce back, alert emails are paused; the Alert emails page says so and lets you turn them back on.',
		category: 'farmer',
		aliases: ['waarskuwings-e-posse', 'alerts'],
		related: ['farm-stop-level', 'farm-forecast', 'farm-wua'],
		source: 'docs/ui.md § Alerts (WP-2.13)'
	},
	// ---- Words on your account pages --------------------------------------------
	// The Account page's Two-step sign-in box and the Invitations page link here
	// for a farmer; the signed-out pages (/mfa-reset, the sign-in code step) say
	// what happens next on the page itself, since this page needs a sign-in.
	{
		id: 'farm-two-step',
		term: 'Two-step sign-in',
		short: 'After your password, a 6-digit code from an app on your phone or from an email, so someone who learns your password still can’t get in.',
		long: 'It is your choice: your hydrological unit’s pages don’t need it. Turn it on under Two-step sign-in on your Account page, in one way or both. An authenticator app on your phone makes a new code every 30 seconds. A code by email is sent each time you sign in and works for 10 minutes. The app is the safer of the two, since anyone who can read your email can also use a code sent there.\n\nThe first time you turn it on, you get ten recovery codes, shown only once. Download or copy them, and keep them somewhere safe, away from your phone. Each one works once, in place of a code. Your Account page says how many are left, and makes a new set when you need one.\n\nIf you lose your phone, sign in with a recovery code. If you have lost your recovery codes too, choose to use a recovery code on the step that asks for the code, then the link for lost recovery codes, and we email you a link. Once you open it, two-step sign-in is removed after 3 days, and you are signed out on every device; nothing else about your account changes. The wait keeps your account safe from someone who knows your password: we email you every day until then with a link to cancel, and signing in with a code cancels it too.',
		category: 'farmer',
		aliases: ['tweestap-intekening', '2FA', 'authenticator', 'recovery codes', 'lost phone', 'code by email'],
		related: ['farm-invitation'],
		source: 'docs/security.md § Two-step sign-in; docs/ui.md § Sign-in pages, § Account'
	},
	{
		id: 'farm-invitation',
		term: 'An invitation to a catchment',
		short: 'An email asking you to join a catchment, usually from your WUA. Nothing changes until you accept, and you can decline.',
		long: 'Your WUA, or whoever models the catchment for it, invites you by your email address. The invitation names the catchment, who sent it, what you join as, the hydrological units it links you to, and the date it is open until. After that date, ask whoever sent it for a new one.\n\nWhen you accept as a farmer, you see the pages of those hydrological units: the figures your WUA published for them, your dam and your water. You never see another hydrological unit’s name or figures. When you decline, whoever sent it sees only that you declined. Nobody can make you join.\n\nThe people who run the catchment’s model see your name, your email address and which hydrological units you are linked to. Other farmers in the catchment never see your name, your email address or your figures. If the hydrological units named aren’t yours, decline and tell your WUA.',
		category: 'farmer',
		aliases: ['uitnodiging', 'invite', 'accept', 'decline'],
		related: ['farm-wua', 'farm-two-step'],
		source: 'docs/ui.md § Invitations; docs/security.md § Authorization (farm scope)'
	}
];
