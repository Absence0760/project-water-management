// The "Pages, one by one" guides: what each workspace page is for and how to
// work it; the page's section header links here ("How this page works",
// TAB_GUIDE in lib/workspace/tabs.ts). Joined into GUIDES by ./guides.ts, in
// a module (and a chunk, vite.config.ts helpArticlesChunk) of their own: as one
// module the guides passed the bundle guard's per-chunk ceiling (2026-10-13).
// Same markup as every guide (./guides.ts `inline`); type-only import, so no cycle at run time.

import type { Guide } from './guides';

export const PAGE_GUIDES: Guide[] = [
	{
		id: 'scenarios-page',
		title: 'Scenarios: try a change without copying the project',
		summary: 'Make a named list of changes on a run (a bigger dam, a new crop, less rain), run it, and read it against the run it started from.',
		kind: 'page',
		tab: 'scenarios',
		sections: [
			{
				heading: 'What a scenario is',
				blocks: [
					{
						type: 'p',
						text: 'A [[scenario]] is a named list of changes on a **base run**: raise a dam by 20 %, replace a crop, remove a hydrological unit, add a transfer, scale the rain by −10 %. It runs and compares against its base without copying the project, and the model itself never changes: the base run stays as it was, and is kept while the scenario exists.'
					},
					{
						type: 'p',
						text: 'Use one to answer “what if”. Copying the project ([[guide:create-a-project]]) is the other way, for a change too large to describe as a list of edits.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Run the model at least once: a scenario needs a run to start from.',
							'On **Scenarios**, press **+ New scenario**, name it and pick its base run (the [[published-baseline|published run]] by default, else the latest).',
							'Under **Add a change**, add each change in turn. Each reads in words against the value it meets (“dam capacity 120 000 → 144 000 m³”), so a second change to the same value shows the first one’s result as “was”. Tick **Explain each setting under its field** (beside Undo; the same switch as in Settings, remembered by your browser) to see how each kind of change works under its fields.',
							'Read the label on each change: a **Proposal** is the change being assessed; a **Baseline assumption** changes what the river is like today (rain, a setting, a Reserve rule) and puts a red **Baseline assumptions changed** callout above the list.',
							'Press **Run scenario**. The run joins Runs & results tagged **Scenario**, and **Scenario against its base** shows the headline water balance and each hydrological unit against the base run.',
							'To bring an older scenario up to date, open **Based on … Rebase…** under **Application details**: **Check** lists any change that no longer applies, then **Rebase onto this run**.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A change that doesn’t apply to its base (a hydrological unit removed since, say) says why, and **Run scenario** stays off until it is fixed or removed.'
					}
				]
			},
			{
				heading: 'Scenarios and licence applications',
				blocks: [
					{
						type: 'p',
						text: 'A licence [[application]] is a scenario too: one an applicant builds on the published baseline. It shows on the Scenarios list with its status, and its changes are frozen once submitted. [[guide:applications-page]] covers the rest.'
					}
				]
			}
		],
		terms: ['scenario', 'run', 'published-baseline', 'application'],
		related: ['compare-runs', 'applications-page']
	},
	{
		id: 'applications-page',
		title: 'Applications: licence applications, applied for and assessed',
		summary: 'How a water-use licence applicant models their change on the published baseline, and how the project’s assessors read and decide it.',
		kind: 'page',
		tab: 'applications',
		sections: [
			{
				heading: 'What an application is',
				blocks: [
					{
						type: 'p',
						text: 'Someone applying for a water-use licence (to build or raise a dam, to abstract more, to irrigate more land) needs to show what their change does to the river and to the users around them. In this app their proposed change is a licence [[application]]: a [[scenario]] on the [[published-baseline|published baseline]], run by the same model as everything else.'
					},
					{
						type: 'p',
						text: 'Two sides use it. The **applicant** (the developer, the farmer or their consultant) builds and submits it. The **assessors** are the project’s editors and owners (other than the applicant), who read it. Only an assessor the responsible authority has confirmed as acting for it (**Acts for the authority** on the Project page) records the authority’s decision; the app records that decision, it never makes one.'
					}
				]
			},
			{
				heading: 'Before anyone can apply',
				blocks: [
					{
						type: 'steps',
						items: [
							'Publish a run as the baseline: in **Runs & results**, **Publish this run**. Applications start from it; with nothing published an applicant can’t start one.',
							'On the **Project** page, add the applicant as a member with the **Applicant** role, and link them to their own hydrological units if they already farm in the catchment.'
						]
					},
					{
						type: 'p',
						text: 'An applicant never sees the model. Their view is a page of their own applications, other farms show only by an anonymous name (“Farm 1”), and nothing unpublished reaches them.'
					}
				]
			},
			{
				heading: 'What the applicant does',
				blocks: [
					{
						type: 'steps',
						items: [
							'Start a **New application** (a name; it starts on the published baseline).',
							'Add the proposed change with the scenario editor: a new hydrological unit with its dam, a bigger dam, a river pump, more hectares of a crop.',
							'Press **Run scenario**, then read **Your results against the baseline**: the Ecological Reserve, the catchment’s flow, their own hydrological units, and the farms downstream of them.',
							'Fill in the notice’s **Address** and **Closing date** for written objections while it is a draft.',
							'Press **Submit to the assessors**. Its changes are frozen; it can still be withdrawn, or reopened as a draft.'
						]
					},
					{
						type: 'p',
						text: 'While it is a draft only the applicant and the people they share it with can see it.'
					}
				]
			},
			{
				heading: 'What the assessors do',
				blocks: [
					{
						type: 'p',
						text: 'The **Applications** tab lists every submitted, withdrawn or decided application (never a draft), with its applicant, status, when it was submitted, its changes, runs and [[evidence-pack|evidence packs]]. It is hidden from the sidebar until you turn it on in **Choose sections**, and viewers never see it.'
					},
					{
						type: 'list',
						items: [
							'**Decide the longest waiting** opens the application that has waited longest for a decision.',
							'Open one to read its changes and runs in Scenarios and answer the applicant’s questions about rules they can’t see. Once the authority has decided, an assessor confirmed as acting for it presses **Record the authority’s decision** and records it with its reasons; anyone else reads it but has no such button.',
							'**Assess together** runs several applications on one baseline, each on its own and all together, for their combined effect on the river.',
							'Draft an evidence pack from a run’s evidence report, then sign and issue it: a frozen, versioned copy anyone can check with its short code.'
						]
					}
				]
			}
		],
		terms: ['application', 'published-baseline', 'scenario', 'evidence-pack', 'roles'],
		related: ['scenarios-page', 'project-page']
	},
	{
		id: 'allocations-page',
		title: 'Allocations: registered volumes against modelled use',
		summary: 'Import the volumes each user is registered or licensed for, and see where a run’s modelled use is above or below them.',
		kind: 'page',
		tab: 'allocations',
		sections: [
			{
				heading: 'What the page is for',
				blocks: [
					{
						type: 'p',
						text: 'Each water user in the catchment is registered (WARMS) or licensed for a volume a year. This page sets those volumes beside what a run modelled each hydrological unit using, per water year, so you can see where modelled use runs above or below the registration. It is under *Outcomes* in the sidebar, shown by default.'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Modelled use is modelled, not metered: a difference is something to look into, not a finding. A registration is not an entitlement.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
														'Press **Import** and upload a WARMS extract or a CSV (**Download the CSV template** shows the columns). A WARMS extract asks how you obtained it; the preview says how many rows matched a hydrological unit.',
							'Or press **+ Add volume** for one at a time: a take from the river or a borehole, or a dam’s storage.',
							'Match any volume the header counts as “not matched” to its hydrological unit.',
							'Pick the run to compare with in the header’s run menu, and read each unit’s modelled use against its registered volume.'
						]
					},
					{
						type: 'p',
						text: 'The baseline only compares. A scenario’s [[allocation-mode]] can make its run cap each unit’s use at its registered volume, or take every registered volume in full (licence data never drives the baseline); this page then says what the run did.'
					}
				]
			},
			{
				heading: 'Who sees names',
				blocks: [
					{
						type: 'p',
						text: 'Owners and editors see every volume. Viewers see only catchment totals per water source held by five or more users, until an owner ticks **Viewers see each farm’s registered volumes** under **What viewers see**.'
					}
				]
			},
			{
				heading: 'Reading the comparison',
				blocks: [
					{
						type: 'list',
						items: [
							'The list puts first the units to look into: each unit and water source with its status over a mean water year. Pick one to see its water years, the [[allocation-band|band]] and its registered volumes.',
							'Each water year reads above registered, within band, below registered, or no registered volume ([[registered-vs-modelled]]). A part year is compared with the volume prorated to its days and isn’t counted with the whole years.',
							'The [[allocation-band|comparison band]] is set at the foot of the page, in the **Comparison band** card beside **What viewers see**: editors change it and press that card’s **Save**. It changes how the comparison reads, never a run’s water.',
							'A dam’s registered storage (a [[s21-water-use|s21(b) row]]) is set against the dam’s modelled capacity, never against the year’s use ([[registered-storage]]).',
							'After a cap run, the picked unit says on how many days the cap held use back, and why ([[cap-held-back]]).',
							'**On the map** opens a map of the hydrological units, each unit’s polygon shaded by its band of modelled use against its registered volume, for the water source and the period you pick (the mean of the whole water years, or one); a unit with no polygon on the Map is listed under it with its band, and a click on a unit opens its comparison. Viewers who see only totals don’t get it.',
							'**Every hydrological unit and water year** charts modelled use ÷ the registered volume for each whole water year, one row per unit and source, with the table under it.',
							'Under **Registered volumes**, **Imported files** lists each import with its rows, who imported it and its SHA-256; an editor can **Remove this import**, which takes its rows out again.'
						]
					}
				]
			}
		],
		terms: ['registered-volume', 'authorisation-type', 'registered-vs-modelled', 'licence-conditions', 'warms-import', 'allocation-mode', 'allocation-band', 'allocation-viewer-access', 'water-year'],
		related: ['run-and-read-results', 'units-page']
	},
	{
		id: 'map-page',
		title: 'The Map: the catchment’s geography',
		summary: 'Draw or upload the boundary, parcels, dams, gauges and rivers, and let the map propose areas and the catchment above a point.',
		kind: 'page',
		tab: 'map',
		sections: [
			{
				heading: 'What the page is for',
				blocks: [
					{
						type: 'p',
						text: 'The Network is the model’s schematic: what drains into what. The [[catchment-map|map]] is the geography: the catchment boundary, each unit’s area, the farm parcels, dams, gauges and rivers. A model builds and runs without it; with it, areas come from the drawing instead of being typed, and results can be read on the map.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Draw the boundary with **Draw a shape**, or **Upload GeoJSON** (WGS84). The header counts the features and gives the boundary’s area.',
							'Add dams, abstraction points and gauges with **Place a point**, and parcels with **Draw a shape**. **Snap to features** puts a corner on a neighbour’s corner or edge.',
							'With an elevation model on the server, **Delineate** draws the terrain channels (solid lines): click one at the catchment’s outlet and the catchment above it is proposed, following the terrain, to accept or reject. The river network’s dashed lines are for reference only and can sit off the terrain channels.',
							'A catchment over about 100 km across is worked out in the background (or tick **work it out in the background**); the map shows the proposal when it is ready. Where pans drain part of it, **Which area** lets you take the gross area (the default, as WR2012’s quaternaries are) or the effective one without them.',
							'On a dam’s card, say whether it stands **On the river** or **Off-channel** (filled by a pump or a furrow): Start and Divide place an off-channel dam’s unit where its own outflow meets the river, and propose its inflow and runoff shares from that.',
							'An accepted boundary is on the map only, not in the model yet. Its card, and the message after accepting, offer the next step: **Divide the model** gives each unit its boundary’s area and order (**Start from the map** while the model is empty makes a unit of each boundary), each value ticked to take it.',
							'While the model is empty, **Start from the map** proposes the units, their areas and their order from the boundary and the points; each value is ticked to take it.',
							'With water occurrence data on the server, **Trace a dam** proposes a dam’s outline from a click inside it.',
							'**Measure** and **Download GeoJSON** are there for everyone, viewers too.'
						]
					}
				]
			},
			{
				heading: 'Layers and search',
				blocks: [
					{
						type: 'p',
						text: '**Layers** (the button under the zoom buttons, or the **Layers** tab beside the map) turns on the optional layers, each kept in the page’s address so Back undoes it and the view can be shared: **Quaternary catchments** (the outlines around the catchment, their codes listed as buttons), **River network** (the reaches around the catchment, biggest first: pick one for its facts and source, and an editor can add it to the map as a river), **Hydrological units** (each unit’s polygon with its name), **MAP grid** (a loaded mean annual precipitation grid’s points in view, each with its MAP), **CHIRPS grid** (CHIRPS’s 0.05° cells and their centres, where a unit’s CHIRPS rain comes from), **DEM grid** (one in a hundred of the elevation model’s cells, each with its height) and **Relief** (hills shaded from the elevation model). The DEM grid and the relief need an elevation model on the server; a grid with too many points in view asks you to zoom in. **Area fill**, at the top of the panel, sets how strongly units, dams and results colours are filled (outlines stay): lower it to see the map, relief and grids through them.'
					},
					{
						type: 'p',
						text: 'The search box over the map’s top edge (**Find**, or Enter) finds the map’s own reference layers first, then places ([[map-search]]): gauging stations by code or name, the register of dams by number or name, quaternary catchments by code, then towns, farms, rivers, pans, peaks and areas. Every word you type must start a word of the name, in any order. One match moves the map to it; several are listed, and picking one moves the map. Nothing is drawn or saved. Place names come from a gazetteer the server operator loads: where none is loaded the search says so, and it still finds gauges, dams and quaternaries.'
					},
					{
						type: 'list',
						items: [
							'**Snap to features** puts a corner on a neighbour’s corner or edge; with **Follow edges** on too, two corners in a row on one outline take that outline’s corners between them, so a parcel drawn against its neighbour or the boundary shares their edge with no gap or overlap ([[map-snap]]).',
							'**Delineate** → **Sub-catchments, one per click** gives each click on a terrain channel the land that drains to it before any other click: click from the outlet up, check the pieces, then save them as areas, link each to its unit and **Use** its area ([[sub-catchments]]).'
						]
					}
				]
			}
		],
		terms: ['catchment-map', 'map-search', 'map-snap', 'delineation', 'sub-catchments', 'map-area', 'area-basis', 'map-checks', 'map-results', 'quaternary', 'farm-area'],
		related: ['start-from-the-map', 'build-the-network']
	},
	{
		id: 'dams-page',
		title: 'Dams: every dam’s level in one run',
		summary: 'How full each dam ran, how long it sat at its minimum, and how storage moved over the record.',
		kind: 'page',
		tab: 'dams',
		sections: [
			{
				heading: 'What the page shows',
				blocks: [
					{
						type: 'p',
						text: 'Every hydrological unit with a [[dam-capacity|dam capacity]] of at least 1 m³, with its [[dam-storage|storage]] from the latest run: how full it is as a share of that day’s capacity, a sparkline of the record, and how many days it sat at its [[dam-min|minimum level]]. Pick a dam for its chart.'
					},
					{
						type: 'p',
						text: 'Levels are shares of the capacity on the day, so a dam losing capacity to [[dam-sediment|sediment]], or coming into service part way through the record, reads correctly. **Open in Runs & results** goes to the run the page shows.'
					}
				]
			},
			{
				heading: 'Proposals and assurance',
				blocks: [
					{
						type: 'p',
						text: 'Under the picked dam’s chart, **Assurance of supply** is the supply of the hydrological unit the dam serves, since a dam has none of its own: how often and how fully its demand was met, and its stress by month ([[assurance-of-supply]]), with a link to the unit on Hydrological units.'
					},
					{
						type: 'p',
						text: 'Under that, in the same panel, **Proposed from the register and the map** is folded to one line of what is proposed for that dam; open it, or follow a card’s **Proposals**, for the values ([[dam-proposals]]). It lists the registered dams within 1 km of the dam on the map, each with its capacity for reference only (a unit’s dam stands for all its farm dams, many of them unregistered, so its volume is yours to enter), and the dam’s polygon on the map, which proposes its area as the full-supply area. Each row shows its source and what the model holds now; **Use** (editors, the area only) asks first, then saves that one value as a change naming its source. **Dam of** picks another dam, and the chart follows, or a hydrological unit with no dam yet. Before the first run the proposals sit in a panel under the cards.'
					}
				]
			}
		],
		terms: ['dam-storage', 'dam-capacity', 'dam-min', 'dam-evaporation', 'spill', 'dam-proposals', 'assurance-of-supply'],
		related: ['run-and-read-results', 'a-day-on-a-farm']
	},
	{
		id: 'river-page',
		title: 'EWR: is enough left in the river?',
		summary: 'One run’s river against its Ecological Reserve: the days the EWR was not met, the water account and how this run differs from the one before.',
		kind: 'page',
		tab: 'river',
		sections: [
			{
				heading: 'What the page shows',
				blocks: [
					{
						type: 'p',
						text: 'Every EWR result for one run, gathered here so the Summary can be about irrigation: the headline tile, the share of days the EWR was not met at the outflow gauge ([[ewr-days-not-met]]) or, when a Reserve rule table judges the results, the share of months its rules were met, with its change from the run before; the days below the reserve in each of the last twelve months; the flow chart against the [[ewr]]; [[reserve-compliance|Reserve compliance]] at each EWR site; and the [[water-account]] of where the catchment’s water went.'
					},
					{
						type: 'p',
						text: 'The page shows the newest run; pick another with the **Run** menu in the header (Back returns to the one before). **Open in Runs & results** opens the same run there.'
					}
				]
			},
			{
				heading: 'How sure, and what if',
				blocks: [
					{
						type: 'p',
						text: 'Under the findings, **How sure, and what if** holds the tools you run yourself, each one row with **Run…** until it has run: the **Uncertainty bands** on the findings, with the **Sensitivity runs** ([[guide:read-the-uncertainty|Read how sure a result is]]); the **Outcome matrix**, how the river fares at a few demand levels in dry, normal and wet years; and the **Seasonal outlook**, the coming season from the catchment as it stands, with the weather of each past year ([[guide:plan-the-season|Weigh a season’s demand level]]). They need an ordinary run, not a scenario or forecast run, and change no result.'
					}
				]
			}
		],
		terms: ['ewr', 'ewr-days-not-met', 'reserve-compliance', 'water-account', 'pragmatic-ewr', 'uncertainty-bands', 'outcome-matrix', 'seasonal-outlook'],
		related: ['set-the-ewr', 'run-and-read-results', 'read-the-uncertainty', 'plan-the-season']
	},
	{
		id: 'units-page',
		title: 'Hydrological units: how much demand each run supplied',
		summary: 'Each unit’s irrigation demand against what a run supplied, who is short this week, and the curtailment and assurance of supply panels.',
		kind: 'page',
		tab: 'supply',
		sections: [
			{
				heading: 'What the page shows',
				blocks: [
					{
						type: 'p',
						text: 'One card per hydrological unit with the share of its [[irrigation-demand]] the run supplied, beside the picked unit’s chart. Three tiles head the page: **Irrigation supplied** over the whole record ([[irrigation-supplied]]), with the units below 95 % and the change from the run before under it; **Short this week**, how many units were short on any of the run’s last 7 days, which opens the curtailment over those days; and the **Total shortfall**, in Mm³ a year and m³/day ([[irrigation-deficit]]).'
					},
					{
						type: 'p',
						text: 'Below the cards: the curtailment panel with its reporting window and share-the-pain board ([[guide:curtailment-targets]]), and [[assurance-of-supply]]. Pick another run with the run menu in the header, and **Open in Runs & results** opens it there.'
					}
				]
			}
		],
		terms: ['irrigation-demand', 'irrigation-supplied', 'irrigation-deficit', 'assurance-of-supply'],
		related: ['curtailment-targets', 'run-and-read-results']
	},
	{
		id: 'project-page',
		title: 'Project: members, publishing and sharing',
		summary: 'What the project holds, who can open it and with which role, and how a run reaches the people outside the model.',
		kind: 'page',
		tab: 'project',
		sections: [
			{
				heading: 'What the page holds',
				blocks: [
					{
						type: 'list',
						items: [
							'One column, read top to bottom in the order the page’s **On this page** list gives: the project’s details, then who can open it, then its notes, facts and reports.',
							'**Download** in the header: the whole project as one JSON file (model, settings and input series), for every member.',
							'**Members**: who can open the project and with which [[roles|role]]. Owners add people and change roles.',
							'**Farmers**: which hydrological units each farmer is linked to; a farmer reads only their own.',
							'**Share links** (owners only): read-only links for people outside the project, to the published baseline; the list also holds every link to an application, so an owner can withdraw any of them from one place.',
							'**API keys** (owners only): keys a logger gateway or a script sends daily readings with ([[guide:push-logger-data|Push logger data with an API key]]).',
							'**Two-step sign-in** (owners only): **Require two-step sign-in** for the project’s owners and signers ([[guide:two-step-sign-in|Sign in with two steps]]).',
							'**The model**, after who can open it: headline facts (units, gauges, catchment area, dams, irrigated area, transfers, series, runs), each linking to where it is edited.',
							'**Scheduled reports**, last, under the model: the latest run’s report PDF emailed to chosen members every week or month. Editors and owners add, pause and remove schedules; viewers read them.',
							'Scheduled reports and API keys save as you change them; the project’s details wait for **Save changes** at the foot of the page.'
						]
					}
				]
			},
			{
				heading: 'Licensing panels',
				blocks: [
					{
						type: 'list',
						items: [
							'**Registration checks** (editors and owners): someone at your organisation looks a specialist signer up on the public register and records it here (**+ Record a check**), so the verify page says “checked against the register” for their sign-offs; anyone else’s reads “self-declared”. The app checks nothing itself. An owner’s switch makes issuing an evidence pack wait until each specialist signer has a check from the last year ([[registration-check]]).',
							'**Responsible authority** (editors set it): who decides the project’s licence applications, a catchment management agency or the Department of Water and Sanitation, with its office. Recorded decisions and the evidence report name it ([[responsible-authority]]).',
							'**Acts for the authority**: who may record the authority’s decisions. An owner proposes an editor or owner; a proposal grants nothing until someone already acting for the authority confirms it, and the first is confirmed by the operator on the authority’s letter.',
							'**Licence record** (editors and owners): the outcome of the licence the project’s evidence supports. Issued packs and signed-off runs keep their signers’ names until three years after the licence ends, or after another outcome; until one is recorded an owner confirms every five years that the record is still needed ([[licence-record]]).'
						]
					}
				]
			},
			{
				heading: 'Roles',
				blocks: [
					{
						type: 'p',
						text: 'A **viewer** reads everything; an **editor** also changes the model, uploads data and runs it; an **owner** also manages members. A **farmer** reads only the units linked to them. An **applicant** builds licence applications on the published baseline and never sees the model ([[guide:applications-page]]).'
					}
				]
			},
			{
				heading: 'Publishing a run',
				blocks: [
					{
						type: 'p',
						text: 'Nobody outside the model sees a run until an editor publishes it: in **Runs & results**, **Publish this run**, with the catchment’s restriction notice. That run is the [[published-baseline]]: farmers read their figures from it, share links show it, and applications start from it.'
					}
				]
			}
		],
		terms: ['roles', 'published-baseline', 'project', 'registration-check', 'responsible-authority', 'licence-record', 'share-link', 'two-step-sign-in'],
		related: ['create-a-project', 'applications-page', 'two-step-sign-in']
	},
	{
		id: 'model-settings-page',
		title: 'Model settings: what the model runs on',
		summary: 'The settings a run reads besides the network and the data: the period, rain gaps, demand, flow generation, the EWR and how results are read.',
		kind: 'page',
		tab: 'settings',
		sections: [
			{
				heading: 'What the page holds',
				blocks: [
					{
						type: 'p',
						text: 'One long form, under **Build the model**, before **Calibration**. **Flow generation** comes first, the lead card and the side index’s first link: how rain becomes each unit’s natural flow (Per unit), not the runoff model’s parameters, which are fitted under **Calibration → Flow calibration**. **EWR the results are judged by** follows it; then the panels by task: **Data & rain** (Simulation period, Rain gaps, Data quality), **Demand & supply** (Demand, Drought restrictions, Reporting), **EWR & Reserve** (EWR, Reserve rule tables), **Reading results** (Outcome matrix, Seasonal outlook, Evidence) and **Automatic runs**. Each panel says what it is set to under its heading.'
					},
					{
						type: 'p',
						text: 'The panels that set up the runoff model’s fit, **Flow calibration**, **Calibration record**, **Fit the parameters** and **WR2012 check**, are on [[guide:calibration-page|Calibration]]. Both pages edit the same settings: an edit on one and an edit on the other wait together for **Save changes** on the one save bar, which shows on both, and a problem on either page is listed there with a link to its panel. Going from one page to the other keeps your edits and never asks; leaving the project with edits unsaved asks first.'
					},
					{
						type: 'p',
						text: 'Viewers read every panel with its fields read-only. See [[guide:set-the-ewr|Set the EWR and the reporting window]] for the EWR.'
					}
				]
			}
		],
		terms: ['ewr', 'apan', 'unit-rain'],
		related: ['set-the-ewr', 'calibration-page', 'rain-gap-filling']
	},
	{
		id: 'calibration-page',
		title: 'Calibration: fit the runoff parameters and judge the fit',
		summary: 'Where the fit is set up and where a run’s fit is read: one page for the calibration loop.',
		kind: 'page',
		tab: 'calibration',
		sections: [
			{
				heading: 'What the page is for',
				blocks: [
					{
						type: 'p',
						text: '[[calibration|Calibration]] is a loop: set the runoff model’s parameters, run the model, compare the modelled flow with the observed record, and adjust. This page brings the two halves of that loop together, so the loop stays on one page. It is under **Build the model**, after **Model settings**, and every member sees it. Its header says where the parameters came from (the fit, its score and whether anything changed since), with **Fit the parameters** to go to that panel. Under the header, one line answers how the shown run fits: its NSE, KGE and volume bias, with **All the scores** to the panel, or why there are none yet. When the GR4J parameters in the form differ from the ones the shown run used, that line says so and a note over the run’s results lists each change (X1 350 → 321 mm), so the old run’s scores aren’t read as the edit’s: run the model to score them. The side index lists both halves’ panels: the four that set up the fit, then those of the run shown, with **Calibration check** and **Where the parameters came from** indented under **Calibration against observed flow**.'
					},
					{
						type: 'p',
						text: '**Set up the fit** holds **Flow calibration** (the GR4J parameters, the rain GR4J runs on and its potential evaporation, with **Evaporation from the map**), **Calibration record** (the observed flow a fit is scored against, its window and what is left out), **Fit the parameters** (fit automatically, the fit record and the calibration rules) and **WR2012 check**. They are the same settings as **Model settings**’: their edits wait for **Save changes** on the one save bar with the rest, and a problem on either page is listed there with a link to its panel. Viewers read them with every field read-only and no fit controls.'
					},
					{
						type: 'p',
						text: '**How the shown run fits** shows the Model quality panels for one run: **Hydrograph**, **Flow-duration curve**, **Calibration against observed flow** and **EWR test: model against observed flow**, with **Runoff model**, **WR2012 check** and **Plausibility checks** when the run has them. Pick the run under its heading: it starts on the run picked on Runs & results, or the latest (a viewer’s, the published one), and **Open in Runs & results** goes to that run’s own page. With no observed flow record yet it says to add one on **Data**; with a record but no run, to run the model with **Run model** at the top. Viewers see every result, without the fit controls.'
					},
					{
						type: 'p',
						text: '**Flow calibration** here is not **Flow generation** on **Model settings**: Flow calibration holds the runoff model’s parameters (how rain becomes flow), the model selection how the rain reaches each hydrological unit.'
					}
				]
			},
			{
				heading: 'The loop: fit, save, run, read',
				blocks: [
					{
						type: 'steps',
						items: [
							'**Choose what the fit is scored against.** In **Calibration → Calibration record**, pick the observed flow series (a gauge or a logger), the [[calibration-window]] and any [[calibration-exclusions]], each with its reason. Do this before you look at a score.',
							'**Fit.** In **Calibration → Fit the parameters → Fit automatically**, choose the objective by what the results will feed, keep **Validate** ticked, and press **Fit automatically**. You can open other pages while it runs; the result waits here. Read the shaded validation columns, then press **Apply to form**. To set a parameter by hand instead, change it under **Flow calibration** ([[guide:calibrate-by-hand|Calibrate by hand]]).',
							'**Save.** The fitted parameters are an unsaved edit until you press **Save changes** on the save bar. The bar is the same on Model settings, so an edit there and one here save together; a problem on either page is listed on the bar with a link to its panel. **Preview** on the bar shows what your unsaved change does to the last run first, worked out in your browser.',
							'**Run.** Press **Run model** in the header. A run started here opens back on this page.',
							'**Read.** Under **How the shown run fits**, the new run is shown: the **Hydrograph**, the **Flow-duration curve** and **Calibration against observed flow** (its scores, the calibration check of flow against use, and where the parameters came from), then the WR2012 check and the plausibility checks when the run has them. Pick an earlier run under the heading to compare by eye, or use **Compare runs** for the full comparison.',
							'**Repeat** until the validation scores are as good as the record allows. The header always says where the shown parameters came from and whether anything has changed since the fit.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'Links to these panels from before they moved here (an old **Model settings** or **Runs & results** bookmark, a note, an email) still land on the panel here, for the same run.'
					}
				]
			}
		],
		terms: ['calibration', 'gr4j'],
		related: ['fit-automatically', 'calibrate-by-hand', 'how-calibration-works']
	},
	{
		id: 'warnings-page',
		title: 'Warnings: every flagged period and run warning, with its fix',
		summary: 'Patch suspicious rain, leave bad flow out of calibration, or keep the values as recorded, one period at a time or many at once.',
		kind: 'page',
		tab: 'warnings',
		sections: [
			{
				heading: 'What the page lists',
				blocks: [
					{
						type: 'p',
						text: 'The **Data checks** list one row per period a [[data-quality-limits|data check]] flagged on a stored series: a flat stretch, outliers, negative values, a zero rain run, an accumulation, a water year far below CHIRPS, or a break in a double-mass curve. Each row names the record, the days, what the check saw and what the next run does with it. It has its own row in the sidebar, after **Data**, with the number of open items beside it; the **Data checks** panel on **Data** and the run warnings on **Runs & results** and **Calibration** link here too.'
					},
					{
						type: 'p',
						text: 'Filter by **Status** (Open, Patched, Excluded, Kept, Handled by default, All), by **Check** and by **Record**; each chip says how many rows it would show, and the filters stay in the address, so a link or Back keeps them. **Handled by default** rows are periods the run already deals with: a flagged zero run set aside and filled, an accumulation spread over its days, a negative flow read as missing.'
					}
				]
			},
			{
				heading: 'Solving a warning',
				blocks: [
					{
						type: 'p',
						text: 'Every row says **How to fix** in plain words, with the action that does it. Some fixes are one setting the page can change for you: **Spread accumulations**, **Set flagged zero runs aside**, **Remove the broken periods**. The row then reads **Fixed: rerun to confirm** until you press **Run now**, and the new run’s warnings show here. Others take you to the exact field, opened and outlined (**Go to Keep dry**, **Go to the calibration window**), or to the page where it is fixed (**Add data**, **Go to Data feeds**). A failing feed has **Fetch now**; a run a known engine bug may affect has **Run the model**.'
					},
					{
						type: 'p',
						text: 'Anything you accept as it is, **Keep**, with a note saying why if you like: it moves under **Kept** with the note, and **Reopen** brings it back. The filters at the top (**Source**, **Status**, **Severity**, **Area**, **Record** and **Find**) work on every row and stay in the address; tick rows, or **Select all N matching**, to keep or reopen many at once.'
					}
				]
			},
			{
				heading: 'Problems elsewhere',
				blocks: [
					{
						type: 'p',
						text: '**Problems elsewhere** gathers what other pages show as needing attention, each with **Go to …** where it is fixed: problems in the model (the dot beside Network, Crops & demand or Transfers), unsaved settings that stop **Save changes**, data feeds that are failing or behind, series whose last day is old, and the newest or published run a known engine bug may affect. These have no tick box: their fix is on their own page. The **Source** chips at the top show one kind at a time (Data checks, Model, Unsaved settings, Data feeds, Data behind, Runs, Run warnings), each with its count, and the number beside **Warnings** in the sidebar is the page’s **Open** count: the open data-check periods, these problems and the run’s open warnings, less those kept.'
					}
				]
			},
			{
				heading: 'Deciding a period',
				blocks: [
					{
						type: 'steps',
						items: [
							'**Rain: Patch or Keep.** **Patch** treats the days as missing, so the run fills them as it fills any gap in the rain (the catchment gauge’s periods go to **Model settings → Rain gaps** as rain treated as missing; any other rain record’s to its unreliable periods there). **Keep** keeps the values as recorded: a zero run as dry days, an accumulation as one day’s reading.',
							'**Flow: Exclude from calibration or Keep.** **Exclude** reads the days of that one record as missing, so the calibration scores, the fit and the plausibility checks leave them out; the other records keep theirs. The periods are listed under **Calibration → Calibration record**. **Keep** scores a flagged outlier or flat stretch as read, Fit automatically included.',
							'**Many at once.** Tick rows, or **Select all N matching** for every row the filters show (folded rows too), then **Patch**, **Exclude** or **Keep**. Neighbouring and overlapping periods are joined into one; a list that would pass its limit (100 periods a list, 200 unreliable periods a rain record, 300 kept checks) is refused with a message, never cut.',
							'**Run the model.** Each decision saves at once, with a reason in the History (“Warnings: patched 3 flat stretches”), and the usual note says the inputs changed since the latest run. **Reopen** on a decided row takes it back out of its list.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'A viewer reads the list and its statuses without the tick boxes and buttons. A flat stretch that grows with new data is a new period, so it comes back as open.'
					}
				]
			},
			{
				heading: 'Run warnings',
				blocks: [
					{
						type: 'p',
						text: '**Run warnings** lists what the shown run warned about (the latest run, or the one picked on Runs & results), things to check first, then notes on how the data were handled. Each warning the engine gives a code links to the setting that changes it (**Go to Rain gaps**, **Go to Calibration record**) or to **Data** when the fix is to load or rename a series; the rest are listed as they are.'
					}
				]
			}
		],
		terms: ['data-quality-limits', 'flow-missing', 'calibration-exclusions'],
		related: ['add-data', 'calibration-page', 'rain-gap-filling']
	},
	{
		id: 'history-page',
		title: 'History: every change, who made it and when',
		summary: 'The model’s change log: read any earlier version, see how it differs from now, and restore it as a new change.',
		kind: 'page',
		tab: 'history',
		sections: [
			{
				heading: 'What the page shows',
				blocks: [
					{
						type: 'p',
						text: 'Every saved change to the model and settings, every upload, run, publication and membership change, newest first and grouped by day, each with who made it, when, and the reason they gave. Filter by **Hydrological unit**, **Kind of change** or **Parameter**; a field’s own history line links here with those filters set.'
					},
					{
						type: 'p',
						text: 'Pick a saved version to see **Differences from now**. An editor can restore it; restoring saves it as a new change, so nothing is ever erased. It is hidden from the sidebar until you turn it on in **Choose sections**.'
					}
				]
			}
		],
		terms: ['run', 'roles'],
		related: ['project-page', 'restriction-log-page']
	},
	{
		id: 'restriction-log-page',
		title: 'Restriction log: every restriction published to farmers',
		summary: 'Which restriction the water user association published, when, by whom and on which run, kept for the life of the project.',
		kind: 'page',
		tab: 'restrictions',
		sections: [
			{
				heading: 'What the page shows',
				blocks: [
					{
						type: 'p',
						text: 'Every time a run is published to farmers, and every time the [[restriction-notice|restriction notice]] of the publication in force is changed, newest first: the day and time, who did it, the level and cut, the notice in each language it was written in, the season the figures cover, how many hydrological units got them, the next publication date and the staff note. The decision farmers read now is marked **In force**.'
					},
					{
						type: 'p',
						text: 'It is the record a water user association shows its members and the responsible authority. The Publication panel in Runs & results keeps the last 12 publications; this log keeps them all. A change to the staff note alone isn’t a restriction decision and shows only in History.'
					},
					{
						type: 'p',
						text: 'Open it from **Restriction log** on the Publication panel. **Open the run** goes to the run a decision rested on while that run is still kept. Viewers, editors and owners read it; farmers read the notice in force on their own page.'
					}
				]
			}
		],
		terms: ['published-baseline', 'restriction-notice', 'roles'],
		related: ['history-page', 'run-and-read-results']
	}
];
