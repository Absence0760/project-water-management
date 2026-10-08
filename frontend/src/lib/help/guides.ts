// Guides for the /help page: how-tos and "how it works" explainers, beside
// the glossary in ./content.ts. Each guide has its own page
// (/help/guides/<id>); diagrams are inline SVG components
// ($lib/components/help/diagrams), keyed by DiagramId.
//
// Inline text markup, parsed by `inline()` (no HTML, so nothing is {@html}):
//   **Save**                 a UI label, shown in bold
//   *Outcomes*               a section or a word to stress, in italics
//   [[ewr]]                  link to a glossary entry, labelled with its term
//   [[ewr|the Reserve]]      the same, with its own label
//   [[guide:add-data|label]] link to another guide
// Every reference must resolve (guarded by guides.test.ts).

import { TAB_LABELS, type TabId as WorkspaceTabId } from '$lib/workspace/tabs';
import { helpFor } from './content';
import type { ShotId } from './pictures';

export type GuideKind = 'start' | 'howto' | 'use' | 'concept' | 'page';

export const GUIDE_KIND_TITLES: Record<GuideKind, string> = {
	start: 'Start here',
	howto: 'How to',
	use: 'Using the results',
	concept: 'How it works',
	page: 'Pages, one by one'
};

/** The workspace tabs the setup path walks, in the order a catchment is set up. */
export const SETUP_TABS = ['overview', 'network', 'crops', 'transfers', 'series', 'settings', 'runs'] as const;

/**
 * Tabs under *Build the model* that the setup path skips: optional, not a
 * step every catchment needs (the Map, issue #288: a model builds and runs
 * without one). "Getting around a project" still names them in place.
 */
export const OPTIONAL_MODEL_TABS: readonly string[] = ['map'];

/** Project workspace tabs a guide can point at (`?tab=`): every one. */
export type TabId = WorkspaceTabId;

/** Their names, the workspace's own (lib/workspace/tabs.ts), so help can't drift from a rename. */
export const TAB_TITLES: Record<TabId, string> = TAB_LABELS;

export const DIAGRAM_IDS = [
	'workflow',
	'network',
	'pipeline',
	'farm-day',
	'gr4j',
	'calibration-loop',
	'validation',
	'rain-sources'
] as const;
export type DiagramId = (typeof DIAGRAM_IDS)[number];

export type GuideBlock =
	| { type: 'p'; text: string }
	/** Numbered steps: things to do, in order. */
	| { type: 'steps'; items: string[] }
	| { type: 'list'; items: string[] }
	| { type: 'note'; tone: 'tip' | 'caution'; text: string }
	| { type: 'formula'; text: string }
	| { type: 'diagram'; id: DiagramId; caption: string }
	/** A close-up of the help illustration, with numbered stops on it. */
	| { type: 'picture'; shot: ShotId; caption: string; stops: PictureStop[] };

/** A numbered stop on an illustration (a guide picture, or the /help tour). */
export interface PictureStop {
	/** The feature's key in the shot's marker map ($lib/help/pictures.json). */
	spot: string;
	title: string;
	/** Inline markup, like guide text. */
	text: string;
	/** The guide that explains it in full. */
	guide?: string;
	/** Opens in place under "Show more": key points, and a close-up or a diagram. */
	more?: { points: string[]; shot?: ShotId; diagram?: DiagramId };
}

export interface GuideSection {
	heading: string;
	blocks: GuideBlock[];
}

export interface Guide {
	/** Stable slug: /help/guides/<id>. Lowercase, hyphenated. */
	id: string;
	title: string;
	/** One or two sentences for the guide list and search. */
	summary: string;
	kind: GuideKind;
	/** The workspace tab where the work happens, if there is one. */
	tab?: TabId;
	sections: GuideSection[];
	/** Glossary ids worth reading next. */
	terms?: string[];
	/** Other guide ids. */
	related?: string[];
}

export const GUIDES: Guide[] = [
	// ---- Start here ---------------------------------------------------------
	{
		id: 'the-whole-process',
		title: 'The whole process, from catchment to results',
		summary:
			'The order to set a catchment up in, what each step needs, and how calibration and what-if runs fit in.',
		kind: 'start',
		tab: 'overview',
		sections: [
			{
				heading: 'What the app answers',
				blocks: [
					{
						type: 'p',
						text: 'A project models one river catchment day by day. Rain becomes natural flow, the flow is shared between the hydrological units, each hydrological unit fills its dam and irrigates, and whatever is left reaches the outlet. Every run answers three questions: how much water is there, can each hydrological unit’s irrigation be met, and does enough stay in the river for the [[ewr]]?'
					},
					{
						type: 'diagram',
						id: 'workflow',
						caption:
							'The setup order follows the workspace’s **Build the model** section, top to bottom; the results are under **Outcomes**. Calibrate and run again until the fit is good enough, then use runs and copies of the project for what-ifs.'
					}
				]
			},
			{
				heading: 'The steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'**Create the project** on the Projects page. See [[guide:create-a-project|Create a project]].',
							'**Network**: add the hydrological units and gauges, say what each drains into, and end at one outflow gauge. Give the hydrological units their areas. See [[guide:build-the-network|Build the river network]].',
							'**Crops & demand** (optional): crops with monthly crop factors, then the hectares each hydrological unit plants. Skip it if nothing is irrigated. See [[guide:set-up-crops-and-demand|Set up crops and demand]].',
							'**Transfers** (optional): pipelines or canals from one hydrological unit’s dam to another. See [[guide:add-a-transfer|Add a transfer]].',
							'**Data**: upload daily rainfall (required) and observed flow at the outlet (needed to calibrate). See [[guide:add-data|Upload rainfall and flow data]].',
							'**Settings & calibration**: A-pan evaporation, the runoff model and its parameters, how rain gaps are filled, the calibration window, the EWR and the simulation period. See [[guide:set-the-ewr|Set the EWR]] and [[guide:fit-automatically|Fit the runoff model automatically]].',
							'**Run** the model on the Runs & results tab, then read the results. See [[guide:run-and-read-results|Run the model and read the results]].',
							'**Iterate**: improve the calibration, run again, and compare runs on **Compare runs**. Copy the project to try a what-if without touching the original. See [[guide:compare-runs|Compare runs and try what-ifs]].'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'The **Summary** tab has a setup checklist that follows these steps. Each line says what is there or what to do next, and links to the tab. It also tells you when the project has changed since the last run. Once there is a run, the Summary opens on the results instead: four cards for the newest run (the reserve, irrigation supplied, how full the dams are and the calibration fit), each with its change; **Days below the reserve** in each of the run’s last twelve months (with a Reserve rule table, whose card judges whole months by the table, it is headed **Days below the pragmatic EWR**, the daily test it counts), where **More on River & reserve** opens the flow chart; **Needs attention** cards (run warnings, new or old data and hydrological units with nothing planted, each a link to where it is fixed), with the **Active alerts** under them; and **Supply by hydrological unit**, the eight least supplied first (**Show all** lists the rest), where a hydrological unit’s name opens its planted areas and **More on Hydrological units** opens that page. The **Dams today** card opens the **Dams** tab. Once the run’s last day is more than a week old, the card says so by its date (**Dams on 31 Dec 2024**), and “this week” and “last 30 days” elsewhere give way to the date the figures end on in the same way. The published baseline and a link to **Project** sit under the supply list. Once every setup step is done, the checklist leaves the page: a **Setup complete** button at the top, beside the rain date, opens the steps over the page.'
					}
				]
			},
			{
				heading: 'Getting around a project',
				blocks: [
					{
						type: 'p',
						text: 'A project’s tabs are grouped in three sections. **Review** holds the Project page, Applications and the History of changes. **Build the model** is what the model is made of, in setup order: Network, the **Map** (the geography: boundary, parcels, dams, gauges and rivers; the Network’s header links to it too), Crops & demand, Transfers, Data and Settings & calibration. **Outcomes** is what the model says: the Summary (where a project opens), River & reserve, Hydrological units, Runs & results, Dams, Compare runs, Scenarios and Allocations.'
					},
					{
						type: 'p',
						text: '**Project**, under *Review*, is what the project is and who can open it: the model’s headline facts (hydrological units, catchment area, dam capacity, irrigated area, transfers, time series, runs and the outflow gauge, each a link to where it is edited), **Project details** (name, description, time zone and WUA name, saved with **Save changes** at the foot of the page, as model edits are), the **Import record** of an imported project, **Recent notes**, and on the right the **Team**, **Members**, **Farmers** and, for owners, **Share links**. **Download** in its header takes a copy of the project. The Summary links there under **Model facts, details, team and sharing**.'
					},
					{
						type: 'p',
						text: '**Dams** has a card for each hydrological unit’s dam: how full it was at the end of the latest run, its change over the last 30 days and its last year as a small line (% full, with its first and last day and its lowest level marked; point at it to read a day). The emptiest dams come first, every card shown. Pick a card to chart that dam’s storage (as % full or m³, over 30 days, a year or the whole run); the link can be shared. Under the chart is the assurance of supply of the hydrological unit the dam serves (a dam has none of its own): how often and how fully its demand was met, and its stress by month, with a link to the unit on Hydrological units. A card’s figures are the latest run’s; its capacity is the model’s now, and a dam whose own settings (or how its hydrological unit draws on it) were edited since the run says **Dam settings changed since the run** and what changed, until the model is run again (the Network’s map marks it the same way); edits upstream of it aren’t checked, so re-run after those too. A dam with a minimum operating level also shows how many days of its last year it sat at that minimum. Each card also opens the dam’s hydrological unit on the Network (**On the Network**) and the hydrological unit’s **Planted areas**. Before the first run the cards show each dam’s capacity only.'
					},
					{
						type: 'p',
						text: 'On a wide screen the sections are in the sidebar down the left, under the catchment’s name and your role (owner, editor or viewer); **Projects**, **Teams** and **Help** are at the top of it, and your account at the foot. A number beside **Data** counts the rainfall and evaporation series that are more than a week behind. On a phone, the **Menu** button in the bar at the top opens Projects, Teams and Help, and the project’s sections sit behind a **Sections** button that names the tab you are on, under the catchment’s name. The arrow keys move from one tab to the next.'
					},
					{
						type: 'p',
						text: 'Each section opens with one header: its name, a line saying what it shows (the run on the Summary and on River & reserve, the hydrological units and dams on the Network, where the runoff parameters came from on Settings & calibration, how many series are behind on Data), and its actions on the right. **Rain up to** says how current the rainfall is (click it for every series). Editors also get **Add data**, which uploads a file, and **Run model**, which opens a small form for an optional **Run label**, **Run forecast** when there is forecast rain, and **Run model**; the run opens in **Runs & results** when it finishes. On **Runs & results** that form sits in the header itself. On a phone the actions sit under the name in full-width rows, with **Add data** and **Run model** (on Runs & results the run form) at the end.'
					},
					{
						type: 'p',
						text: 'Each page adds its own actions to the header. The Network has **Map** (the geographic map: boundary, parcels, dams and gauges), **Tables**, **+ Add hydrological unit** and, once there is an outlet, **+ Add other user**; the Map **Upload GeoJSON**, **Start from the map** while the model is empty (the boundary, then the dams, abstraction points and gauges, and the units, their areas and their order are proposed, each value ticked to take it), **Divide the model** once it has hydrological units (with an elevation model: each point on the map stands for its hydrological unit, and its own area and order are proposed beside its values now, each ticked to take it; each proposed piece carries its number on the map and on its card), and a **Getting started** pill while the boundary or the rain feed reading it is still to do. The Map’s tools sit on the map’s left edge: **Measure**, **Draw**, **Point** (place a point), **Delineate** (when the server has an elevation model: the elevation model’s own channels are drawn as solid **terrain channels**, named in the bar and the Key beside the river network’s dashed lines, which are for reference only; click a terrain channel and the catchment above it, following the terrain, is proposed over the dimmed channels, to accept or reject, or pick **Sub-catchments, one per click** and each click gets the land that drains to it before any other click, to save as areas; a point beside a much larger channel is offered that channel first, since river lines can sit hundreds of metres off the channel the elevation model sees) and **Trace** (a dam, when the server has water occurrence data: click inside a dam and its outline is proposed as a drawing to adjust and save); a strip over the map names the tool that’s on, and Escape leaves it. **Layers** turns on the quaternaries, the river network and the relief; **Key** says what the colours mean and what the areas are coloured by. Beside the map, one panel at a time: **Details** of the picked feature, **Features** (with **Download GeoJSON** and **Every feature**, the table), **Checks**, **Layers** and **Key**; the map’s own **Layers** button (under the zoom buttons) and **Key** button (bottom left, beside **Show everything**) open those tabs, or on a phone a panel over the map. While drawing, **Snap to features** puts a corner on a neighbour’s corner or edge (hold Alt to place one exactly), and a polygon’s card has **Split along a line**; Crops & demand **Tables**, **Load crop factors…** and **+ Add crop**; Transfers **Show on the Network** and **+ Add transfer**; Data **Preview all data**; Settings & calibration **Fit the parameters**, which jumps to the Fit automatically panel. River & reserve and Hydrological units have a menu to pick the run and a link to it in Runs & results, and Dams the same link; Scenarios has **+ New scenario**; Allocations **Download CSV**, **Import** and **+ Add volume**; Project **Download**; Applications **Decide the longest waiting**. Notices sit in one line under the header: that you can only view the project, what an upload added, or that new data has arrived since the last run, with **Re-run model** for editors.'
					},
					{
						type: 'p',
						text: 'Nothing you edit takes you off the page. **Tables** opens a full table over the page: the Network’s has the **Hydrological unit table**, **Crop factors**, **Planted areas**, **Transfers** and **Demands**, Crops & demand’s the crop factors and planted areas. **+ Add hydrological unit**, or **Edit** on its row under **All hydrological units** (or a double-click on it in the drawing), opens its form in a sheet over the page; **+ Add crop**, or **Edit** on a crop’s row, opens the crop’s. Each grid and sheet has its own **Save changes**, **Discard model changes** and **Done**, which brings you back where you were. The **Hydrological unit table**, **Crop factors** and **Planted areas** also take a block copied from a spreadsheet: paste it into any cell, or use **Paste from a spreadsheet…** under the grid. With the names in the first column and a heading row (as **Download the table as CSV** gives them), rows and columns can come in any order; a bare block of numbers fills from the cell you pasted into. A preview lists every value it would change before **Apply**, and nothing is kept until you save.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'To change one hydrological unit’s planted areas without leaving the page you are on, open its **Planted areas**: select the hydrological unit on the Network and follow **Irrigated** on its card beside the map, pick the hydrological unit’s name in the Summary’s **Supply by hydrological unit**, its name beside its bar on Crops & demand, or **Planted areas** on its card on Hydrological units or Dams. It opens beside the page and saves with the rest of the model.'
					},
					{
						type: 'p',
						text: 'Notes keep what lives in people’s heads (“dam raised in 2019 per owner”) against what it is about. The speech-bubble button, with a count once there are notes, is on each hydrological unit on the Network (its card beside the map and its row in the Hydrological unit table), on a run’s record in Runs & results, beside each group’s heading on Settings & calibration and on **Recent notes** on the Project page. It opens the notes in a panel down the right: write a new one at the top, and the notes, newest first, scroll under it. Everyone on the project can add one; you edit your own. On a hydrological unit, **Also show to this hydrological unit’s farmers** lets its farmers read it too; every other note stays with the project team.'
					}
				]
			},
			{
				heading: 'What “good enough” means',
				blocks: [
					{
						type: 'p',
						text: 'A run is only as trustworthy as its calibration. Judge the parameters by the **validation** scores (days the fit never saw), not by the in-sample fit, and check the simulated natural flow against [[wr2012-check|WR2012]] where you can. The guides under “How it works” explain why.'
					}
				]
			}
		],
		terms: ['water-balance', 'project', 'run'],
		related: ['how-the-model-works', 'how-calibration-works']
	},

	// ---- How to -------------------------------------------------------------
	{
		id: 'create-a-project',
		title: 'Create a project',
		summary: 'Start a new catchment, put it in a team, and copy an existing one to try a what-if.',
		kind: 'howto',
		tab: 'overview',
		sections: [
			{
				heading: 'A new project',
				blocks: [
					{
						type: 'steps',
						items: [
							'Open **Projects** in the sidebar (on a phone, under **Menu**) and press **New project**.',
							'Give it a name, usually the catchment or river. Under **Belongs to**, pick a team if others will work on it, and press **Create**.',
							'The project opens on its **Summary** tab. Work through the setup checklist from the top.'
						]
					},
					{
						type: 'p',
						text: 'One project holds one catchment: its network, crops, settings, input series and runs. A b023 workbook becomes one project; an administrator can import one with the workbook importer.'
					}
				]
			},
			{
				heading: 'Start from an example',
				blocks: [
					{
						type: 'p',
						text: 'To look round a finished model before building your own, press **Start from an example** on the Projects page while you have no projects. It makes an invented winter-rainfall catchment your own project (four hydrological units, fruit farms with dams, two transfers, a calibrated runoff model and 15 years of made-up rainfall), runs it and opens that run on **Runs & results**. Every name and number in it is made up. Change it as you like, and delete it from its row’s **⋯** menu when you’re done.'
					}
				]
			},
			{
				heading: 'Reading the Projects page',
				blocks: [
					{
						type: 'p',
						text: 'Each row says how its catchment is doing, from its published run (or its latest run when none is published): the EWR over the last 30 days in words, the hydrological units short this week, the lowest dam, how far the rain data goes (**Rain to 31 Dec 2024 (20 months ago)**), when the project was last edited and when it last ran. Once a catchment’s figures are more than a week old, “this week” and “last 30 days” become the dates they end on (“short in the week to 31 Dec 2024”). **Needs attention** at the top lists the catchments to look at first (a red or amber EWR, hydrological units short, alerts firing, failing feeds, newer rain than the figures, figures over a week old), each with its reasons. The chips filter by owner, and **Sort** or a column heading orders the list; both stay in the page’s address.'
					}
				]
			},
			{
				heading: 'A copy for a what-if',
				blocks: [
					{
						type: 'steps',
						items: [
							'On the Projects page, open the **⋯** menu on the project’s row, choose **Copy…** and name the copy. The model and the data are copied; runs are not.',
							'Name it after the change you plan, for example “Raise dam 3 by 20 %”.',
							'Make the change in the copy and run it. The original and its runs are untouched.',
							'Compare the copy’s run with the original’s. See [[guide:compare-runs|Compare runs and try what-ifs]].'
						]
					}
				]
			},
			{
				heading: 'Who can do what',
				blocks: [
					{
						type: 'p',
						text: '[[roles|Editors]] change the model, upload data and run it. Viewers see everything, can fit the runoff model to explore, and can download results, but can’t save or run. A viewer’s workspace says “View only”. In a team, each person has the same role on every team project as in the team; owners can also delete, share and move the project (sharing and moving are on its **Project** page).'
					}
				]
			}
		],
		terms: ['project', 'run'],
		related: ['the-whole-process', 'build-the-network']
	},
	{
		id: 'build-the-network',
		title: 'Build the river network',
		summary: 'Add hydrological units and gauges, connect each one to the element it drains into, and end at one outflow gauge.',
		kind: 'howto',
		tab: 'network',
		sections: [
			{
				heading: 'The shape of a network',
				blocks: [
					{
						type: 'p',
						text: 'The network is a tree. Each element drains into exactly one element downstream, and exactly one element, the [[outflow-gauge]], drains nowhere. An element can have several upstream neighbours. The model works out the calculation order itself, upstream first.'
					},
					{
						type: 'diagram',
						id: 'network',
						caption:
							'A small network. Hydrological units are circles, hydrological units with a dam are filled squares, gauges are triangles, and the outflow gauge is filled. The dashed arrow is a transfer between two dams.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Start with **Add outflow gauge**: the gauge at the catchment outlet.',
							'Press **+ Add hydrological unit** for each hydrological unit (its form opens in a sheet over the map), set its **Kind**, and set **Drains into** to the element directly below it on the river. To enter many at once, use the hydrological unit table (**Tables** › **Hydrological unit table**).',
							'Add gauges where you want to read flow in the middle of the catchment, for example at a weir with a record.',
							'Give every hydrological unit its **area** (km²). With the Hi/Lo flow-share method, also split it into high-MAP and low-MAP areas.',
							'For a hydrological unit with a dam, set the [[dam-capacity]], the [[dam-initial|initial storage]], its [[dam-min|minimum level]], and how much of the upstream inflow and of its own runoff enter the dam. A hydrological unit’s full form (**Edit** on its row under **All hydrological units**, or double-click it in the drawing) also has the dam’s [[dam-evaporation|area when full]] and its [[dam-seepage|seepage]].',
							'Set the share of the water supplied that returns to the river as [[return-flow|return flow]] (10 % for a new unit) and any [[diversion|diversion back to the dam]]. The hydrological unit’s [[irrigation-efficiency|irrigation efficiency]] comes from its crops’ [[irrigation-system|irrigation systems]] (Crops & demand). Under **Supply**, set where its irrigation comes from (the [[supply-rule|supply rule]]); **Split the crops’ water between sources** gives it a [[crop-supply-table|crop supply table]]: fixed shares from its own dam, the river at the unit and another unit’s dam.',
							'Press **Save changes** on the save bar (or in the hydrological unit’s sheet).'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'In the schematic you can drag a hydrological unit onto another to change what it drains into. A drop that would make a loop, or move the outlet, is refused with the reason. In the hydrological unit table (**Tables** › **Hydrological unit table**), **Sort by flow path** orders the rows from each headwater down. Once the model has been run, the map shades each hydrological unit by the share of its irrigation demand that run supplied (95% or more, 70–95%, under 70%; **Colour hydrological units by** › **Supply, latest run**, on by default); a hydrological unit added since the run is hatched. The same menu colours the hydrological units by their dam level at the end of the latest run. A name longer than 17 characters is shortened on the map, keeping the ending when two names would otherwise look alike (hover a hydrological unit, or read the list beside the map, for its full name); a transfer that can’t curve clear of the names is drawn round them.'
					}
				]
			},
			{
				heading: 'Dams and natural areas',
				blocks: [
					{
						type: 'p',
						text: 'A hydrological unit also covers two other cases, set by its parameters:'
					},
					{
						type: 'list',
						items: [
							'**Stand-alone dam**: no crop areas (so no irrigation), 100 % of its runoff (and of upstream inflow, if it sits on the main stem) into the dam, and no diversion.',
							'**Natural area**: no crops, no dam capture and no diversion. It simply passes its runoff on.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A river that splits in two (a bifurcation) can’t be drawn. Use a transfer for the side channel, or merge the hydrological units.'
					}
				]
			}
		],
		terms: ['network', 'element-farm', 'element-gauge', 'outflow-gauge', 'upstream-to-dam', 'runoff-to-dam'],
		related: ['a-day-on-a-farm', 'add-a-transfer']
	},
	{
		id: 'set-up-crops-and-demand',
		title: 'Set up crops and irrigation demand',
		summary: 'Crops with monthly crop factors, the hectares on each hydrological unit, A-pan evaporation and effective rain.',
		kind: 'howto',
		tab: 'crops',
		sections: [
			{
				heading: 'How demand is worked out',
				blocks: [
					{
						type: 'formula',
						text: 'gross demand (m³/day) = Σ crops [ area × A-pan (mm/month) × crop factor ] ÷ days in the month'
					},
					{
						type: 'formula',
						text: 'effective rain Pe = cropped area × the day’s rain (0 at or below the threshold) × effective-rain fraction; crop requirement = gross − min(soil store + Pe, gross)'
					},
					{
						type: 'formula',
						text: 'irrigation demand (abstraction) = crop requirement ÷ irrigation efficiency'
					},
					{
						type: 'p',
						text: 'Gross demand is the same every day of a month. Rain above the [[rain-threshold]] covers the day’s demand first; what the crop can’t use that day stays in the [[soil-water-store]] (25 mm by default) and covers the following days, so wet spells need less irrigation after the rain too. The hydrological unit then abstracts more than the crop needs, to cover its application losses ([[irrigation-efficiency]]).'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Crop factors multiply **A-pan** evaporation, not FAO reference ET₀. A published FAO-56 Kc overstates demand by about 18–67 % (a third at a pan coefficient of 0.75) unless you first multiply it by the pan coefficient (usually 0.60–0.85).'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **Crops & demand**, press **+ Add crop**: its sheet opens over the page. Name it and enter its 12 monthly [[crop-factor|crop factors]] (Oct … Sep). Each crop then has a row in the **Crops** list, largest planted area first, with its colour, area, the month it needs most water and a small chart of its factors (Oct to Sep, the highest marked with its value; point at it to read a month); **Edit** on the row opens the sheet again. A warning icon on a row means a factor above 1.0 (hover or focus it; it opens the sheet). With more than nine crops, the smallest share one grey colour as **Other**, named in their own row.',
							'Under **Planted area by hydrological unit**, press **Edit areas** and enter the hectares of each crop on each hydrological unit in the grid. Leave a crop blank on hydrological units that don’t grow it. Each hydrological unit then gets a bar split by crop in the list’s colours, largest hydrological unit first (hover a segment for its crop and hectares); a note under the bars names any hydrological unit with nothing planted, whose demand is zero.',
							'Check **Irrigation demand by month**: what the catchment abstracts for its crops per month (the gross demand ÷ each hydrological unit’s [[irrigation-efficiency|irrigation efficiency]], so an efficiency below 100 % raises it), stacked by crop, with the year’s total under it. **Show table** gives m³/day per month, the mean, and Mm³ per year per hydrological unit and for the catchment. It comes before effective rain, which a run takes off day by day. It uses the monthly A-pan means: with a daily [[apan|A-pan]] series on the **Data** tab, runs use that on the days it has a value, so their demand differs, and a line under the heading says so.',
							'On **Settings & calibration → Demand**, enter the 12 monthly [[apan|A-pan evaporation]] values (or use them from the map, when an A-pan grid is loaded), the [[effective-rainfall|effective-rain fraction]] and the [[soil-water-store|soil-water store]]. The [[rain-threshold]] is under **Flow calibration**.',
							'Give each crop its [[irrigation-system|irrigation system]] in its sheet (a unit can override it per crop in **Edit areas**); the systems and their efficiencies are under **Tables** › **Irrigation systems**. Each hydrological unit’s [[irrigation-efficiency|irrigation efficiency]] is its crops’ systems combined.',
							'Press **Save changes** on the save bar.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'The full tables are under **Tables** in the section header (Crop factors, Planted areas): they open over the page, and **Done** brings you back. The Crop factors grid also has **Load crop factors…**, to fill them from the reference library, a b023 workbook or a node-based workbook. To change just one hydrological unit, click its name beside its bar, or select it on the **Network** and follow **Irrigated** on its card: its crops and hectares open beside the page, with its demand, and save with the rest of the model. With its parcels linked on the **Map**, that panel also shows **From land cover**: the area a land-cover map shows as cropland in them. Pick the area and the crop it is planted to (the land cover doesn’t say which), and **Use** saves it with its source.'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'With A-pan at 0 in every month the crops need no water, and every hydrological unit looks fully supplied. The Summary’s checklist warns about this.'
					}
				]
			}
		],
		terms: ['irrigation-demand', 'crop-requirement', 'irrigation-efficiency', 'crop-area', 'february-days'],
		related: ['build-the-network', 'curtailment-targets']
	},
	{
		id: 'add-data',
		title: 'Upload rainfall and flow data',
		summary: 'CSV format, updating a series with new days, and the checks to read before you trust a record.',
		kind: 'howto',
		tab: 'series',
		sections: [
			{
				heading: 'What the model needs',
				blocks: [
					{
						type: 'list',
						items: [
							'[[rain-catchment|Catchment rainfall]] (mm/day): required. It drives natural flow and effective rain.',
							'[[chirps|CHIRPS rainfall]] (mm/day): optional. It fills the days catchment rain is blank.',
							'[[rain-forecast|Forecast rainfall]] (mm/day): optional. It extends the record a few days ahead.',
							'[[observed-flow|Observed flow]] at the outlet (m³/s), from a gauge, a logger or both: needed to calibrate.'
						]
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Prepare a CSV with two columns, **date,value**, one row per day. A header row is optional. Leave a missing day blank rather than writing 0. Commas, semicolons or tabs, and decimal points or decimal commas, are worked out from the file. A daily table exported from the DWS hydrology site loads as it is: days its quality code marks as missing, and negative placeholders such as -999, become gaps.',
							'Press **Add data** in the section header, or drop the file anywhere on the page.',
							'Check the series the form guessed from the file name and header, and the preview chart.',
							'For an existing series keep **Append / update**: new days are added and overlapping days corrected. The preview counts new, changed and unchanged days. Use **Replace** only to overwrite the whole series.',
							'Upload. If the file would change days already stored, the form asks first: it says how many days and between which dates, and **Show the changes** lists each one. Press **Overwrite** to go ahead, or **Back**. The values it replaces are kept: in the **History** tab, pick that change and press **Restore the earlier values**. **Cancel**, the close button or Esc asks before throwing away a file you have picked but not uploaded.',
							'Press **Re-run model** in the notice under the header when you are ready.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A missing rain day written as 0 looks like a dry day, and it stops CHIRPS filling the gap. The **Data checks** panel flags long runs of zero rain in the wet season and years that read far below CHIRPS. By default a run treats the flagged zero runs as missing, so CHIRPS fills them; **Settings & calibration → Rain gaps** ([[zero-rain-runs|zero-rain runs]]) keeps a confirmed dry spell dry.'
					}
				]
			},
			{
				heading: 'Checks to read on the Data tab',
				blocks: [
					{
						type: 'list',
						items: [
							'The table lists the series that are **behind** first: rainfall or evaporation a run reads whose data is more than a week old, the same ones the number beside **Data** counts, each marked **Behind**. Then the last date of each series, its coverage per year and % missing. With many series the first six show and **Show all** lists the rest. Click a row (or its **View**) to chart it: the chart, below the table, comes into view; the link can be shared, and Back returns to the series before.',
							'**Data checks**: negative values, outliers, flat stretches, suspect zero rain and breaks in catchment rain’s ratio to CHIRPS, which the [[double-mass|double-mass]] chart shows by water year.',
							'The chart of the catchment rain a run reads shades the days a run treats as missing or spreads a [[rain-accumulations|multi-day accumulation]] over.',
							'With both a gauge and a logger, the [[gauge-logger-agreement|gauge vs logger]] table flags water years where they disagree. Choose the record you trust as the calibration flow series (**Settings & calibration → Calibration record**).',
							'A [[reference-gauge]] on a neighbouring river is kept for ranking wet and dry years only. The model never reads it.',
							'**Preview all data** (in the header, beside **Add data**) or a row’s own **Preview** opens every series’ daily values side by side, searchable by date or value, plus how the model used each day: rain used and its source after gap-fill, the CHIRPS bias factor and corrected value, flow in m³/day, and any calibration exclusion.'
						]
					}
				]
			}
		],
		terms: ['units', 'rain-final', 'chirps-bias'],
		related: ['rain-gap-filling', 'how-calibration-works', 'load-data-feeds']
	},
	{
		id: 'load-data-feeds',
		title: 'Load rainfall and flow automatically with data feeds',
		summary: 'Attach a CHIRPS, CHIRPS-GEFS or DWS feed, set one up from the catchment boundary, and read whether each is keeping up.',
		kind: 'howto',
		tab: 'settings',
		sections: [
			{
				heading: 'What a feed does',
				blocks: [
					{
						type: 'p',
						text: 'A [[data-feeds|data feed]] fetches one source once a day and merges its new days into one series: [[chirps|CHIRPS]] daily rainfall, the [[chirps-gefs|CHIRPS-GEFS]] 16-day forecast, or a [[dws-flow|DWS gauge’s]] verified daily flow. A day the source has no value for never erases what is there. Runs read the series as they read an uploaded one.'
					}
				]
			},
			{
				heading: 'Rain over the catchment boundary',
				blocks: [
					{
						type: 'steps',
						items: [
							'Put the catchment boundary on the **Map** (delineate, draw or upload it).',
							'Open **Settings & calibration → Data feeds** and press **Use the catchment boundary** (the Map’s own link opens it too).',
							'Read the proposal: the CHIRPS cells the boundary covers, the share of each inside it and its weight. A boundary over about 2 500 km² needs feeds for its parts.',
							'An owner presses **Apply**. The feed attaches into the CHIRPS series; if that series already holds a record, it goes into a separate series to compare beside the old one, which you switch off once satisfied.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'See [[boundary-rain|rain from the catchment boundary]] for how the cells are weighted.'
					}
				]
			},
			{
				heading: 'Attach a feed by hand',
				blocks: [
					{
						type: 'steps',
						items: [
							'Press **Attach a feed** (owners) and choose the **Source**, then **Into series**: the kind of series it writes. CHIRPS goes into the CHIRPS series, so it fills the days catchment rain is blank; into catchment rain it becomes the catchment rain itself, used raw.',
							'For CHIRPS, choose the **Daily product**: *sat* from 1998, with preliminary days, or *rnl* from 1981, final days only (see [[chirps-version|CHIRPS product and version]]). Without a start date the feed reads the last 60 days, then keeps up.',
							'For CHIRPS and the forecast, give the **Area**: grid cells (latitude, longitude, an optional weight, one a line) or a bounding box (south, west, north, east). A box on the coast can leave out sea cells.',
							'For DWS flow, pick from **Nearest gauging stations** (river gauges within 50 km of the outlet, with the years their record covers) or type the station code, such as A2H012.',
							'If the series already has data, the form asks: use a separate series, or fill only its empty days. Then press **Attach feed**, and **Run now** to fetch at once rather than wait for the daily run.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Verified DWS flow lags by months and is revised in arrears: it suits calibration, not day-to-day operation.'
					}
				]
			},
			{
				heading: 'Is it keeping up?',
				blocks: [
					{
						type: 'list',
						items: [
							'Each card says its state in words: **OK**, **Stale** (no new day for longer than the source usually takes), **Failing** (with the reason), **Waiting** or **Off**, and when its last data and last check were.',
							'A warning above the list counts the feeds that need attention, and the Projects page lists failing feeds under **Needs attention**.',
							'A **Sample data** badge means this server reads invented sample files, not the real sources ([[synthetic-data]]).',
							'The Data tab marks a rain series **Behind** once its last day is more than a week old ([[data-freshness]]).'
						]
					}
				]
			}
		],
		terms: ['data-feeds', 'boundary-rain', 'chirps-version', 'dws-flow', 'chirps-gefs'],
		related: ['add-data', 'start-from-the-map']
	},
	{
		id: 'start-from-the-map',
		title: 'Start a catchment from the map',
		summary: 'Delineate or draw the boundary, place the dams and gauges, and let the map propose the units, their areas and their order.',
		kind: 'howto',
		tab: 'map',
		sections: [
			{
				heading: 'Before you start',
				blocks: [
					{
						type: 'p',
						text: 'This works on a model with no hydrological units yet. With an [[elevation-model|elevation model]] on the server, each unit’s area and order come from the terrain; without one, you get the units with no areas, to type on the Network. Nothing reaches the model until you tick it.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On the **Map**, press **Start from the map** (or the link on the empty map). Step one is the boundary.',
							'**Delineate from the outlet**: the terrain channels appear; click the one at the catchment’s outlet. The outlet is moved onto the channel ([[outlet-placement]]), and the catchment above it is proposed. Check it against the relief and the mapped rivers, then **Accept as the catchment boundary**. Or draw the boundary, or upload it as GeoJSON.',
							'Place each dam at its wall, each abstraction point where water leaves the river, and the gauges, with **Place a point** or by drawing a dam’s outline. On a dam outline’s card, set its [[dam-siting|siting]] if it is filled by a pump or a furrow.',
							'In the sheet, say what each point is (a unit with a dam, a unit at an abstraction point, another water user, a gauge in the network, or not in the model) and which gauge is the outlet, then propose.',
							'Read the proposal. Each unit’s piece is tinted and numbered on the map, and its card gives its own area, its whole catchment above, what it drains into and, for a dam, the runoff and inflow shares. Read the warnings: dropped points and their reasons, a much larger channel beside a point.',
							'Tick the values to take (**Tick every value** takes them all), choose [[area-basis|gross or effective]] areas where a piece holds pans, name the units, and apply. One model revision writes them, with each area saved as its unit’s parcel.',
							'Follow the data step’s links in order: rain from the boundary, the nearest gauging stations, the dams from the register, cultivated area from land cover, then run the model.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'The areas come from a 30 m global elevation model, not a survey. In flat land a divide can be hundreds of metres out; check each piece against the map before you tick it.'
					}
				]
			},
			{
				heading: 'A model that already has units',
				blocks: [
					{
						type: 'p',
						text: 'Use **Divide the model** instead ([[divide-model]]): say which unit each point stands for, and each unit’s own area and order are proposed beside its values now. Or click the rivers with **Sub-catchments, one per click** ([[sub-catchments]]), save the pieces as areas, link each to its unit and **Use** its [[map-area|area]].'
					}
				]
			}
		],
		terms: ['start-from-map', 'delineation', 'terrain-channels', 'outlet-placement', 'dam-siting', 'area-basis'],
		related: ['map-page', 'build-the-network', 'load-data-feeds']
	},
	{
		id: 'add-a-transfer',
		title: 'Add a transfer',
		summary: 'Move water from one hydrological unit’s dam to another in chosen months, up to a pipe or canal capacity.',
		kind: 'howto',
		tab: 'transfers',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **Transfers**, press **+ Add transfer** in the section header. Each rule is a card: along its top, pick its source (**From**) and destination (**To**) hydrological units.',
							'Under **Max rate by month**, enter its [[transfer-rate|maximum rate]] in m³/s for each [[transfer-months|month]] it runs in, Oct … Sep; leave a month blank to keep it off. **… in every month** copies the largest rate to all twelve.',
							'Under **Limits**, enter a daily cap in m³ if there is one.',
							'Under **Source**, keep **Takes from** on the source’s dam and set the [[transfer-min-storage|minimum storage]] it keeps, or pick the river for an [[transfer-offtake|off-take]] and fill in its fields.',
							'With several transfers, set each one’s [[transfer-priority|priority]] under **Limits**: lower moves first.',
							'The **On** switch at the top right of the card leaves a rule in the model but stops it running (the card turns grey and says **off**); **Remove** deletes it, asking first once it has a rate.',
							'Save, then run.'
						]
					}
				]
			},
			{
				heading: 'What moves each day',
				blocks: [
					{
						type: 'picture',
						shot: 'transfer',
						caption: 'A transfer pipeline on piers, crossing the river between two dams.',
						stops: [
							{ spot: 'pipe', title: 'The pipeline', text: 'Its capacity is the transfer’s [[transfer-rate|maximum rate]] in each [[transfer-months|month]]; a blank month is off.' }
						]
					},
					{
						type: 'formula',
						text: 'transfer = min( source’s water above its minimum, room at the destination, the month’s rate × 86 400, daily cap ),   0 in a month that is off'
					},
					{
						type: 'p',
						text: 'The source’s water is yesterday’s storage above the higher of the transfer’s minimum and the dam’s own [[dam-min|minimum level]], less what earlier transfers took. The room at the destination is the free space in its dam plus that day’s irrigation demand, so water is never pumped into a full dam only to spill. Transfers move before any hydrological unit irrigates.'
					},
					{
						type: 'p',
						text: 'The same volume leaves the source dam and enters the destination, so a transfer never creates or loses water. Transfers with the same priority share a source dam, or a destination’s room, in proportion to their own limits, so the order of the list never changes a result.'
					}
				]
			}
		],
		terms: ['transfer', 'transfer-priority', 'transfer-min-storage'],
		related: ['build-the-network', 'a-day-on-a-farm']
	},
	{
		id: 'set-the-ewr',
		title: 'Set the EWR and the reporting window',
		summary:
			'Enter the monthly pragmatic EWR, then choose the period the curtailment report averages over.',
		kind: 'howto',
		tab: 'settings',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Take the monthly Reserve flows for the river’s [[ecological-category]], usually from the [[desktop-reserve-model]] tables without high flows.',
							'Pick one value per month (often a percentile) and convert it to m³/day.',
							'On **Settings & calibration → EWR**, enter the 12 values, Oct … Sep. The l/s equivalent and the annual volume help catch a unit slip.',
							'Optionally set the **Curtailment reporting window** ([[report-window|reporting window]]) to a drought or dry season. The curtailment table then averages over that period only.',
							'To assess the EWR above the outlet too, add a gauge on the **Network** tab at each EWR site of the Reserve determination.',
							'Save and run.',
							'With a Reserve rule table too, choose which one the results are judged by in **Judge results by**, the first thing on **Settings & calibration**: automatic (the outlet’s rule table, else the first site’s, else the pragmatic EWR), the pragmatic EWR, or one site’s rule table. It changes no result, so no re-run is needed; River & reserve says at the top which one is in use.'
						]
					}
				]
			},
			{
				heading: 'Where the EWR is checked',
				blocks: [
					{
						type: 'picture',
						shot: 'river',
						caption: 'A reach of the river. The EWR is the flow that must stay in it, every day, for the ecosystem to hold its target condition.',
						stops: [
							{ spot: 'river', title: 'The river channel', text: 'Checked every day at the outlet against the [[pragmatic-ewr]], and at every gauge against the EWR of everything upstream of it.' }
						]
					},
					{
						type: 'p',
						text: 'The EWR is assessed at EWR sites: the outflow gauge, against the full [[pragmatic-ewr]], and every gauge, against the [[ewr-share|EWR shares]] of everything upstream of it. On a day a site falls short, the shortfall is charged to the hydrological units upstream of it in proportion to what each took that day, never more than it took; the rest is natural. That [[ewr-charge]] says which hydrological unit causes a shortfall. The results report [[ewr-days-not-met]], an EWR grid by month and, with an observed record, whether the model fails on the days the real river did ([[ewr-agreement]]).'
					}
				]
			}
		],
		terms: ['ewr', 'ewr-shortfall', 'ewr-charge', 'ewr-share'],
		related: ['curtailment-targets', 'run-and-read-results']
	},
	{
		id: 'calibrate-by-hand',
		title: 'Calibrate by hand',
		summary: 'Change a runoff parameter, run, and read the hydrograph and statistics until the fit is right.',
		kind: 'howto',
		tab: 'settings',
		sections: [
			{
				heading: 'Before you start',
				blocks: [
					{
						type: 'list',
						items: [
							'On **Settings & calibration → Calibration record**, choose the calibration flow series (gauge or logger) and the [[calibration-window]]: a period with a record you trust.',
							'Add [[calibration-exclusions]] for periods you can’t trust, each with its reason.',
							'Enter each record’s gauged range (its highest and lowest field gauging) under [[quality-flags|Quality flags]], so days read off the extrapolated rating curve are flagged.',
							'The [[runoff-model]] is GR4J: its parameters are under **Flow calibration**. (The workbook’s legacy model was removed in engine 1.0.0.)'
						]
					}
				]
			},
			{
				heading: 'The loop',
				blocks: [
					{
						type: 'steps',
						items: [
							'Change one parameter at a time. For GR4J start with X1 (soil store: less flow when larger), then X4 (timing of the peaks), then X3 (how slowly flow recedes).',
							'To see what the change does first, press **Preview** on the save bar: the last run against the same run with your unsaved change, worked out in your browser (KGE, NSE, PBIAS and supply). Nothing is saved and no run is made.',
							'Save and run.',
							'On the run, read the **Hydrograph** (observed flow against simulated outflow) and the **Calibration** panel: [[kge|KGE]], [[nse|NSE]], [[pbias|PBIAS]], [[log-nse]] and the annual volume table.',
							'Fix volume first (PBIAS near 0), then the shape of the peaks, then the recessions and low flows.',
							'Compare the run with the previous one to see what the change did.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'Hand calibration is scored only on days the parameters were tuned on (in-sample). Before relying on the parameters, run **Fit automatically** with validation to see how they score on days they never saw.'
					}
				]
			}
		],
		terms: ['calibration', 'gr4j', 'runoff-model', 'base-flow'],
		related: ['fit-automatically', 'how-calibration-works', 'how-gr4j-works']
	},
	{
		id: 'fit-automatically',
		title: 'Fit the runoff model automatically',
		summary:
			'Let the optimiser search the parameters, read the validation scores, then apply and save the fit.',
		kind: 'howto',
		tab: 'settings',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **Settings & calibration → Calibration record**, set the calibration flow series, window and exclusions first. The fit uses the form as it stands.',
							'Go to the **Fit automatically** panel and choose the **Objective** by what the fit will feed (see *Choosing an objective* below), before you see any score.',
							'Choose **Bounds**: Wide, or Typical (Perrin et al.’s published range) when a short record can’t pin the parameters down.',
							'Leave **Model runs per fit** (1 500) and **Starts** (5) at their defaults unless you have a reason. Each start is a separate search from its own seed and the best is kept; the notes say when starts reach nearly the same score with scattered parameters.',
							'Keep **Validate** (split-sample and dry → wet) ticked. With both a gauge and a logger, you can also score the fit against the record it doesn’t use (**Also validate against**).',
							'Press **Fit automatically**. A progress bar shows the stage and the best score so far; **Cancel** stops it.',
							'Read the result: the notes, current vs fitted parameters, and the scores table. The shaded validation columns are the honest measure.',
							'Press **Apply to form**, then save the settings. Nothing is stored until you save.',
							'Run the model with the new parameters.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Expect validation to score below the fit. When it is much lower, or the notes say wet-year behaviour is weakly constrained, the record can’t pin the parameters down. Report that; don’t hide it.'
					}
				]
			},
			{
				heading: 'Choosing an objective',
				blocks: [
					{
						type: 'p',
						text: 'Each [[calibration-objective|objective]] weighs the record differently, so choose it by what the fit will feed, and before you see any score:'
					},
					{
						type: 'list',
						items: [
							'**KGE′** (default): the overall water balance, peaks and events.',
							'**Year-balanced KGE′**: a record where a few wet years would otherwise dominate.',
							'**Mean of KGE′(Q) and KGE′(1/Q)**: EWR, low-flow and assurance-of-supply decisions, when the gauge’s low flows are well rated.',
							'**Non-parametric KGE**: the same decisions when the rating at the extremes is uncertain. It reads the rank order and the shape of the flow-duration curve, so it is less sensitive to rating error.',
							'**NSE on √Q or log Q**: mainly to compare with older studies that used them.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Don’t fit several objectives and keep the one whose score looks best. Scores of different objectives don’t compare, and choosing after seeing them is the overfitting the [[calibration-rules]] exist to stop. To try several, list them in the rules: every fit is then judged on one [[calibration-selection-score|selection score]] on a held-out test, chosen in advance.'
					},
					{
						type: 'p',
						text: 'Check a low-flow fit for volume too: the [[wr2012-fit-statistics]] and KGE′ are reported beside every fit.'
					}
				]
			},
			{
				heading: 'Afterwards',
				blocks: [
					{
						type: 'p',
						text: 'The saved parameters carry a [[fit-record]]: objective, seed, window, exclusions, engine version and every score. Each run keeps the record it was made with. Editing a fitted parameter by hand marks the record “parameters edited since fit”. The same inputs, engine version and seed reproduce the fit exactly.'
					}
				]
			}
		],
		terms: ['auto-calibration', 'calibration-objective', 'validation-tests', 'calibration-bounds', 'calibration-search', 'kge', 'wr2012-penalty'],
		related: ['how-calibration-works', 'calibrate-by-hand', 'check-against-wr2012']
	},
	{
		id: 'check-against-wr2012',
		title: 'Check natural flow against WR2012',
		summary:
			'Enter the quaternary’s published naturalised flow, and every run compares its natural flow with it.',
		kind: 'howto',
		tab: 'settings',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Find the [[quaternary]] the catchment lies in, and its WR2012 naturalised MAR and 12 monthly mean flows. The app doesn’t ship WR2012 data.',
							'On **Settings & calibration → WR2012 check**, tick **Compare runs with WR2012 naturalised flow**.',
							'Enter the quaternary code, its area, MAP (optional), MAR in Mm³/a, the period and the source.',
							'Enter the monthly means in **Mm³ per month**. Their sum should match the MAR within 5 %; the m³/s row shows a unit slip.',
							'Choose the scaling (area, or area and rainfall) and save. Every run from now on has a **WR2012 check** panel.'
						]
					}
				]
			},
			{
				heading: 'Reading the check',
				blocks: [
					{
						type: 'p',
						text: 'The run compares simulated **natural** flow (never the outflow) with the scaled reference: the MAR ratio, the 12 monthly ratios with dry-season months marked, and the correlation of the monthly pattern. A MAR off by 10 % is noted, by 25 % (or 15 % too wet) queried, and by 50 % makes the run unusable for EWR findings until explained. The thresholds are editable.'
					},
					{
						type: 'p',
						text: 'The optional [[wr2012-penalty|MAR penalty]] makes Fit automatically pull the natural MAR towards WR2012, and shows the fit with and without it.'
					}
				]
			}
		],
		terms: ['wr2012-check', 'map', 'wr90'],
		related: ['fit-automatically', 'how-calibration-works']
	},
	{
		id: 'run-and-read-results',
		title: 'Run the model and read the results',
		summary: 'What each results section shows, in order, and what to look at first.',
		kind: 'howto',
		tab: 'runs',
		sections: [
			{
				heading: 'Run',
				blocks: [
					{
						type: 'steps',
						items: [
							'With unsaved changes, **Run model** asks first and offers **Save and run**.',
							'Press **Run model** in the header of any section and optionally type a **Run label** (on **Runs & results** the field is in the header itself), then **Run model**. It needs a network and a rainfall series; until then the form says what is missing.',
							'The runs are listed on the left, newest first, beside the run shown; pick one to show it. Its header links to **River & reserve** and **Hydrological units** for that run.',
							'The new run opens when it finishes. A run keeps a snapshot of the inputs it used, so later edits never change it.'
						]
					}
				]
			},
			{
				heading: 'Read, top to bottom',
				blocks: [
					{
						type: 'list',
						items: [
							'**Summary**: first what to check before relying on the run, then (folded away) notes on how the input data were handled, and a line of model checks (self-checks, plausibility, the WR2012 flag), each linking to its panel. Then a sentence or two in plain words (how often the river’s requirement was met, which hydrological units fell short), and the headline figures, the calibration NSE and PBIAS among them when there is observed flow. The table per hydrological unit is on **Hydrological units** (see below).',
							'**Model quality**: the **Hydrograph** (simulated and observed flow; natural flow is hidden until you click it in the legend) with the **Flow duration** curve under it, **Calibration** with, under its statistics, the **calibration check** (a chart for each gauge with an observed record: observed, simulated, natural flow and the demand upstream on one axis, plus the **bed losses** in the reaches above the gauge when the model has any, so a gap between simulated and observed can be read against the water used, and lost, above the gauge; a forecast run’s lines stop where its forecast starts) and **Where the parameters came from**, the **Water balance** by water year (summed over the hydrological units: rain, the runoff coefficient, storage at the start and end, each gain and loss, in Mm³, with a link to River & reserve’s water account, the catchment’s own), the **Runoff model** (GR4J runs), the **WR2012 check** when set up, **EWR vs observed**, and the **Plausibility checks**.',
							'**Record**: the run’s notes, whether it is the project’s evidence run (see below), and its publication.',
							'**Dig deeper**: **Self-checks** (whether each hydrological unit’s daily balance closes and the reports add up, whether the water balance closes in every water year, with a link to the table, and **Trace a day**; see [[balance-check|the self-checks]]) and **Outputs** (*Explore outputs*): any stored daily series, by node.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'The row of links under the header, **On this page**, jumps to each of these sections and marks the one you are reading; it stays in view as you scroll. In a narrower window the last few are under **More** at its end. **River & reserve**, **Hydrological units**, **Data** and **Settings & calibration** have the same menu.'
					},
					{
						type: 'p',
						text: '**River & reserve**, under *Outcomes* in the sections, is the river’s page for one run (the newest, or pick another from its **Run** menu; the Summary’s **Days below the reserve**, or **Days below the pragmatic EWR** when a rule table judges the results, links there too). A line at the top says which EWR the results are judged by, with **Change** to choose another in Settings & calibration → **Judge results by**. Two tiles: how often the EWR was not met (the days at the outflow gauge, how many in an average year, and the Reserve rule months with a rule table), and the mean simulated outflow and its share of natural flow, each with its change from the run before (the worst month is the EWR by month grid’s **All years** row). Then EWR against outflow with a **30 days / 1 year / All** switch and the days below the pragmatic EWR shaded, beside the days below the reserve each water year. When a Reserve rule table judges the results (by whole months), those bars are headed **Days below the pragmatic EWR, each water year**, the daily test they count, and the chart is headed **Flow vs pragmatic EWR** when the table is at another site than the outlet, since it then draws only the pragmatic EWR (with the outlet’s table it draws the rule requirement too). Below them: Reserve compliance by month (with a rule table), EWR by month with the EWR required and met at each site each water year, the uncertainty bands on those findings, the outcome matrix, the seasonal outlook and the water account (the catchment’s, from natural flow, in m³, with a link to the run’s water balance on Runs & results). On the EWR by month heat map (as % of days) and the Summary’s reserve strip, **green** means the EWR was not met on fewer than 5 % of the days, **amber** fewer than 20 %, and **red** 20 % or more; these are provisional defaults until the hydrologist confirms them (a team can set its own for its portfolio).'
					},
					{
						type: 'p',
						text: '**Hydrological units**, also under *Outcomes*, is the hydrological units’ page for one run (the newest, or pick another from the run menu in its header; the Summary’s **Supply by hydrological unit** links there). Three tiles: irrigation supplied, with the hydrological units below 95 % and its change from the run before under it; the hydrological units short on any of the run’s last 7 days (**Short this week**, which opens the curtailment over those days) and the total shortfall. Then a card per hydrological unit, the three least supplied first (**Show all** lists the rest in place), in the Summary’s and the Network’s colours: its % supplied, its shortfall, its days short in the reporting window and in the last 7 days, and any cut the curtailment asks of it, with links to its hydrological unit on the Network and its planted areas. Pick a card to chart that hydrological unit’s supply against its demand (the days it was short shaded), over **30 days / 1 year / All**, with a link to its dam’s storage on the **Dams** page; the link can be shared, and on a wide screen the chart stays beside the cards as you scroll. Under the chart is that unit’s assurance of supply: how often and how fully its demand was met, and a strip of its stress by month, with a link to every year’s grid. Below them: the **Hydrological unit results** table (hydrological units under 95 % flagged, with a small bar beside each %), the **Curtailment** targets with their **Reporting window** (each hydrological unit’s supply against a fairness benchmark, its EWR charge and the supply cut that meets it, and the EWR sites; see [[guide:curtailment-targets|Curtailment targets]]) and **Assurance of supply**.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'The **Download** menu on a run gives the daily series and the summary as CSV, for your own checks or a report. The two tables with a column per hydrological unit, **Fragmented flow** and **Fragmented EWR**, have a **Preview** beside them that shows the file’s table first, searchable by date, with **Download CSV** to save it. **Report**, beside it, opens a printable catchment report of the run: the network, the inputs it used, calibration, curtailment, EWR compliance for the outlet and every hydrological unit, the hydrological unit table, warnings, self-checks and the run’s notes. Press **Download PDF** once it has finished preparing and choose **Save as PDF** in the print dialog; it prints on A4 in the light theme, without the app’s sidebar or menu bar. **Generate PDF** and **Email me the PDF** make the same PDF on the server instead; the emailed link opens a page that names the catchment and run, says whether the PDF is queued, being made, ready or failed, and offers **Download the PDF** for an hour. Viewers can open it too.'
					}
				]
			},
			{
				heading: 'Notes and the evidence run',
				blocks: [
					{
						type: 'p',
						text: 'Under **Run notes**, write why the run’s results stand, for example why a WR2012 query stands, and press **Save notes**. Everyone who can see the project reads them, in run comparison and in the summary CSV too.'
					},
					{
						type: 'p',
						text: 'Under **Evidence**, give the reason and press **Nominate as evidence** to mark the run the project’s results rely on ([[evidence-run]]). A nomination can’t be edited or removed; nominating another run replaces it, and both stay in the **Nomination history**. A run of the legacy runoff model, made before engine 1.0.0 removed it (badged **Workbook comparison**), can’t be nominated.'
					},
					{
						type: 'p',
						text: 'A run made by an engine with a known bug (or with parameters from a calibration that had one) is tagged **May be affected** in the run list, and its header shows **May be affected by a known bug**. Each bug changes results only under its own conditions: press the badge to open the run’s **Validation statement**, whose errata table says when, then re-run on the current engine and compare. The project’s owners are emailed once when a new bug is confirmed.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'A project keeps its newest runs (20 by default) and deletes the oldest when a new run goes over that. Evidence runs, current or former, are never deleted, and a project that has nominated one can’t be deleted either.'
					}
				]
			}
		],
		terms: ['run', 'fraction-supplied', 'ewr-days-not-met', 'natural-flow'],
		related: ['compare-runs', 'how-the-model-works']
	},
	{
		id: 'compare-runs',
		title: 'Compare runs and try what-ifs',
		summary: 'Set up to two what-ifs against a baseline: which inputs changed, what that did to the results, and every figure in full.',
		kind: 'use',
		tab: 'compare',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Run a baseline.',
							'Change one thing (raise a dam, add crops, add a transfer, refit the parameters) in the same project or in a copy, and run again. That run is a what-if. A scenario’s run, made and run on **Scenarios**, is a what-if too.',
							'Open **Compare runs** (under **Outcomes**, or the link at the top of the runs list on Runs & results). It starts on the latest run (**What-if 1**) against the published run (**Baseline**), or against the run before it when nothing is published. Each run card has its own project and run picker, so any run from any project you can see can take any place.',
							'To weigh two changes against each other, press **+ Add a second what-if**. It picks the newest run that isn’t already on the page; **Remove** takes it off again.',
							'Read the cards (each what-if’s main change), then **What changes**: each outcome for the baseline and every what-if, with the change from the baseline under each what-if’s value (dam storage at the end of the run too, as a share of each run’s own dam capacity), and the takeaways in plain words under it. **Days below the reserve, each year** shows the same test year by year (October to September); when a compared run has a rule table it is headed **Days below the pragmatic EWR, each year**, since the rule table judges whole months instead.',
							'Below that, **Full comparison** has every detail for the baseline against one what-if (pick which): **What changed** (every input difference), **Headline results**, fit and validation, uncertainty, the reserve by month, hydrological units and the daily series. There the baseline is run A and the what-if run B.',
							'To hand the result round, press **Export impact report** (with two what-ifs, pick which). It opens that what-if’s printable report with **Impact against the baseline** first: the same outcomes, takeaways and input changes. **Download PDF** saves it.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Results are daily averages over each run’s own period. When runs cover different periods the page warns you, and so do the takeaways: part of the change then comes from the dates, not from your edit. A takeaway appears only for a material change (a day a year below the reserve, a point of the demand supplied, a hydrological unit crossing 95 %); the table shows everything.'
					},
					{
						type: 'p',
						text: 'Each run shows its run notes in the full comparison, and the page says when either run is, or was, the project’s evidence run. The page’s address holds every run on it, so a comparison can be bookmarked or shared with anyone who can see the projects.'
					}
				]
			}
		],
		terms: ['run', 'project'],
		related: ['create-a-project', 'run-and-read-results']
	},
	{
		id: 'try-a-what-if',
		title: 'Model a what-if with a scenario',
		summary: 'Describe a change as a scenario on a saved run, keep the proposal apart from the assumptions, run it and read what it does.',
		kind: 'use',
		tab: 'scenarios',
		sections: [
			{
				heading: 'Before you start',
				blocks: [
					{
						type: 'p',
						text: 'A [[scenario]] is a list of [[scenario-change|changes]] on a [[base-run]]: the inputs that run stored, never the live model. Start from the run the change should be judged against, usually the [[published-baseline|published run]]. Each change is labelled a **Proposal** or a **Baseline assumption** ([[change-class]]): to see a proposal’s effect alone, settle the baseline assumptions (a corrected setting, new rain data) in the project first and run it again, then start the scenario on that run.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **Scenarios**, press **+ New scenario**, name it after the change (“Upper dam +20 %”) and pick its **Base run**.',
							'Tick **The proposer’s hydrological units**: the units whose owner is proposing the change. Changes to them, and anything the scenario adds, are the proposal.',
							'Add each change under **Add a change**: pick the kind, the target and the new value. It reads in words against the value it replaces. For many edits at once, **Edit in the model tables** and **Record** them ([[override-mode]]).',
							'Check the list: a red **Baseline assumptions changed** callout means some change alters what the river is taken to be today; a change marked **Doesn’t apply** must be fixed or removed before the scenario can run.',
							'Press **Run scenario**. **Scenario against its base** shows the headline results, each hydrological unit, [[assurance-of-supply]] and the daily series against the base run, every change as scenario − base.',
							'For a dam, read **Yield under this scenario** ([[firm-yield]]). For how sure the change is, open the full comparison and compute the [[paired-band|paired band]] ([[guide:read-the-uncertainty]]).'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'To test a demand restriction, use [[scale-demand|Scale demand]] (one change for the whole catchment, or for chosen units and months) rather than editing crop areas: it scales what each unit would take and leaves the crops as they are. To test a wetter or drier climate, [[scale-series|scale every rain series]] the project has, one change each.'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A change applies to the base run’s stored inputs. When the model or the data move on, **Rebase onto another run** carries the changes to a newer run and lists any that no longer apply.'
					}
				]
			}
		],
		terms: ['scenario', 'base-run', 'scenario-change', 'change-class', 'scale-demand', 'run-comparison'],
		related: ['scenarios-page', 'compare-runs', 'read-the-uncertainty']
	},
	{
		id: 'read-the-uncertainty',
		title: 'Read how sure a result is',
		summary: 'Uncertainty bands, sensitivity runs and the paired band: what each answers about EWR compliance, and how to run and read it.',
		kind: 'use',
		tab: 'river',
		sections: [
			{
				heading: 'Three questions, three tools',
				blocks: [
					{
						type: 'list',
						items: [
							'**How far could this result be off, given what the flow record can’t rule out?** The [[uncertainty-bands]]: many parameter sets that all fit the record acceptably, run through the whole model, with the 5–95 % range of what they give.',
							'**Which uncertain input moves it most?** The [[sensitivity-runs]]: rain, the pan coefficient, dam evaporation, abstraction and the dams’ starting storage, each changed alone, with a verdict on whether EWR compliance holds across the range.',
							'**How sure is the change between two runs?** The [[paired-band|paired band]]: the change under each kept parameter set, so the uncertainty both runs share cancels.'
						]
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **River & reserve**, open **Uncertainty** from the page’s menu.',
							'Under **Run an ensemble**, set the rule before looking at any band ([[ensemble-acceptance]]): the number of parameter sets, the bounds and the three tests a set must pass. For an evidence report, use the rule the project declared ([[evidence-uncertainty-rule]]). Press **Run ensemble** and keep the tab open while the browser runs the sets.',
							'Read **Parameter sets kept** and the coverage line first. With fewer than 30 kept there is no band; with coverage of the held-out record below 70 % the band is too narrow to trust. Then read each result’s 5 %, median and 95 % beside this run’s own value.',
							'Under **Sensitivity runs**, press **Run sensitivity**. Read the verdict at each EWR site ([[sensitivity-verdict]]), then the tornado: the factor with the longest bar is the one better data would settle first.',
							'To weigh a change, open **Compare runs** with the run that has the ensemble as the baseline and the what-if beside it, and press **Compute the paired band** under **Uncertainty**.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Each tool leaves something out. The bands vary the runoff parameters, the pan coefficient, the rain source and the record judged against, never the abstraction or the dams’ starting storage; the sensitivity runs vary those one at a time and never together. A result that holds under both is well supported; one that is “not determinable with current data” says what to measure next.'
					}
				]
			}
		],
		terms: ['uncertainty-bands', 'ensemble-acceptance', 'sensitivity-runs', 'sensitivity-verdict', 'paired-band'],
		related: ['fit-automatically', 'compare-runs', 'river-page']
	},
	{
		id: 'plan-the-season',
		title: 'Weigh a season’s demand level',
		summary: 'Run the outcome matrix and the seasonal outlook at a few demand levels, read how past years went at each, and publish the level the WUA sets.',
		kind: 'use',
		tab: 'river',
		sections: [
			{
				heading: 'What the two panels answer',
				blocks: [
					{
						type: 'p',
						text: 'Both run the catchment at a few [[demand-level|demand levels]] (100, 85 and 70 % of today’s demand by default) and count how past years went. The [[outcome-matrix]] looks at the whole record, split into [[year-class|dry, normal and wet years]]: how the river fares at each level in each kind of year. The [[seasonal-outlook]] starts from the catchment as it stands on the decision date (dams, soil, the runoff model’s stores) and runs the coming season with the weather of each past year ([[analogue-years]]). Neither forecasts the weather, and neither recommends a level: the WUA decides.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Run the model on the latest data. Both panels need an ordinary run, not a scenario or forecast run.',
							'In **Settings & calibration**, check **Outcome matrix** (how years are classed and the [[outcome-risk|risk cut-offs]]) and **Seasonal outlook** (the [[outlook-season|season]], the planning share and the review date).',
							'On **River & reserve**, under **Outcome matrix**, type the levels and press **Run demand sweep**. Read across a row for one level in every kind of year, and down a column for every level in one kind of year.',
							'Under **Seasonal outlook**, type the levels (and a monthly plan, if the WUA is considering one) and press **Run seasonal outlook**. Read each level’s season-end storage, demand met and days below the EWR as the median with its 10–90 % range, and the [[planning-figure]].',
							'For a mid-season check, read the [[review-triggers]]: the level each band of total dam storage on the review date supported in past years.',
							'Once the WUA has decided, pick **Level the WUA has set** under **Farmers** and press **Publish to farmers** ([[outlook-publish]]).'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A lower demand level doesn’t always mean fewer days below the EWR: part of the water irrigated from a dam drains back to the river on dry days. With fewer than 10 analogue years the outlook gives no ranges and no planning figure.'
					}
				]
			}
		],
		terms: ['demand-level', 'outcome-matrix', 'seasonal-outlook', 'planning-figure', 'review-triggers'],
		related: ['river-page', 'run-and-read-results']
	},
	{
		id: 'share-with-a-team',
		title: 'Set up a team and share a project',
		summary: 'Make a team for your colleagues, give each a role, move a catchment into it, and share single projects with people outside it.',
		kind: 'use',
		tab: 'project',
		sections: [
			{
				heading: 'Make the team',
				blocks: [
					{
						type: 'steps',
						items: [
							'Open **Teams** in the sidebar and press **New team**. Name it after the consultancy, department or WUA; you are its owner.',
							'On the team’s page, under **Members**, type a colleague’s email and pick a **Role**, then press **Add**. Each person gets an [[invitation]] and joins once they accept it.',
							'Repeat for each colleague. The pending invitations are listed under the form, with **Resend** and **Revoke**; an invitation works for 7 days.'
						]
					},
					{
						type: 'p',
						text: 'A [[team]] role holds on every team project: a **viewer** reads them, an **editor** edits and runs them, and an **owner** owns them and manages the team. Change a member’s role from the list at any time.'
					}
				]
			},
			{
				heading: 'Put a catchment in the team',
				blocks: [
					{
						type: 'steps',
						items: [
							'For a new catchment, pick the team under **Belongs to** in the **New project** dialog.',
							'For an existing one, open it, go to its **Project** page and, under **Team**, choose the team in **Move to** and press **Move**. Only the project’s owners can move it.',
							'Everyone in the team now has the project with their team role. People listed under **Shared directly with** keep their own access too.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'An owner only through the team can’t make the project personal again: add yourself under Members as an owner first.'
					}
				]
			},
			{
				heading: 'Share one project with someone outside the team',
				blocks: [
					{
						type: 'list',
						items: [
							'**A colleague or client who works on the model**: add them under **Members** on the Project page with a [[roles|role]]. Anyone with a role is a member of that project only.',
							'**A farmer**: press **Invite farmers** under **Farmers** and tick their hydrological units. They read only those units, from the published run ([[farmer-link]]).',
							'**Someone who only needs to look** (a forum, an NGO): make a [[share-link]] under **Share links**. It opens the published baseline without signing in, for as long as you choose.'
						]
					},
					{
						type: 'p',
						text: 'Every addition, role change and link is recorded on the [[change-history|History]] page with who made it.'
					}
				]
			}
		],
		terms: ['team', 'roles', 'invitation', 'share-link'],
		related: ['project-page', 'create-a-project']
	},
	{
		id: 'push-logger-data',
		title: 'Push logger data with an API key',
		summary: 'Let a logger gateway or a script add daily readings to a project’s series without signing in, and keep an eye on it.',
		kind: 'howto',
		tab: 'settings',
		sections: [
			{
				heading: 'Make a key',
				blocks: [
					{
						type: 'steps',
						items: [
							'Make sure the series exists: upload its record once on the **Data** tab, with the name the gateway will send. A key creates a series only when the project has none of that kind.',
							'As an owner, open **Settings & calibration** and go to **API keys**.',
							'Give the key a **Name** that says where it runs (“Weir logger gateway”), choose how long it **Works for**, and under **What it may write** choose **Only these series** and tick the ones it feeds.',
							'Press **Make key** and copy the key at once: it is shown only this once. Store it in the gateway’s own settings, never in a shared file.'
						]
					}
				]
			},
			{
				heading: 'Send the readings',
				blocks: [
					{
						type: 'p',
						text: 'The gateway sends each day’s readings to the ingest address with the key, as in the example request shown under the new key: the series’ kind and name, its unit, the first date and one value a day. Only the days sent change, in the series’ own units, and sending the same days again changes nothing, so a gateway can safely resend the last week every day.'
					},
					{
						type: 'p',
						text: 'Each push shows in **History** as **API key “name”**. When the project re-runs automatically, a push that changed days queues a run. A push that looks wrong (a negative value, a value far above the record’s usual range, or a series it had to create) is still stored, but holds the automatic runs until a person runs the model.'
					}
				]
			},
			{
				heading: 'Keep an eye on it',
				blocks: [
					{
						type: 'list',
						items: [
							'The key’s row shows when it was **Last used**.',
							'Switch on **API data behind** in the Summary’s alert rules to be emailed when a series the key sends stops getting readings ([[alert-rules]]).',
							'If a key leaks or the gateway is retired, press **Revoke**: the key is refused from its next request. Make a new key for a replacement gateway.'
						]
					}
				]
			}
		],
		terms: ['api-key', 'alert-rules', 'change-history'],
		related: ['add-data']
	},
	{
		id: 'issue-an-evidence-pack',
		title: 'Issue an evidence pack',
		summary: 'Turn a run’s evidence report into a signed, hashed pack with a short code that anyone can check on the public verify page.',
		kind: 'use',
		tab: 'runs',
		sections: [
			{
				heading: 'Before you start',
				blocks: [
					{
						type: 'list',
						items: [
							'The baseline must be the project’s [[evidence-run|nominated evidence run]]. For an [[application]], run the application on that baseline.',
							'Declare the [[evidence-uncertainty-rule|uncertainty rule]] under Settings, Evidence, and run an ensemble to it, so the report has bands to cite.',
							'The signer needs two-step sign-in, and, while the project requires it, a current [[pack-signoff|registration check]] recorded on the **Project** page.'
						]
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Open the [[evidence-report]]: **Evidence report** beside **Report** on Runs & results, or from the head of a scenario’s comparison.',
							'Read the checks at the top. Fix every one marked “stops issue” ([[pack-issue-checks]]), run the model again and nominate the new run if the baseline changed, then read **Expect questions about**.',
							'For an application with registered volumes, press **Run at full authorised use**, so page 1 carries the [[full-authorised-use|impact against full authorised use]].',
							'Press **Create evidence pack**. The pack’s page opens: a draft, with its checklist under **Where this pack stands**.',
							'In Appendix B.2, the applicant’s specialist presses **Sign off this evidence pack…**, fills in their registration and ticks every confirmation. An assessor may add a second sign-off as a review.',
							'Once every line of the checklist is ticked, an editor presses **Issue pack** and confirms. Signing and issuing ask for a fresh code from the authenticator app.',
							'The server then prints the pack’s PDF, builds its [[reproduction-bundle]] and re-runs it; the pack page shows each as it lands. Hand the [[pack-short-code|short code]] to whoever needs to check the pack, use **Send to the authority…** for the full pack, and **Share link…** for the public.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Issuing is public and permanent: the verify page shows the signers’ names and registrations, and an issued pack is never edited or deleted. A change of evidence is **New version…**; a pack that shouldn’t stand is **Withdraw…**, with a reason anyone holding the code can read.'
					}
				]
			}
		],
		terms: ['evidence-pack', 'pack-lifecycle', 'manifest-hash', 'pack-short-code', 'pack-signoff', 'errata-since'],
		related: ['applications-page', 'run-and-read-results']
	},

	// ---- How it works -------------------------------------------------------
	{
		id: 'how-the-model-works',
		title: 'How the model works',
		summary: 'The chain from daily rain to hydrological unit supply, dam storage, outflow and the EWR check.',
		kind: 'concept',
		sections: [
			{
				heading: 'The daily chain',
				blocks: [
					{
						type: 'diagram',
						id: 'pipeline',
						caption:
							'One run, every day of the simulation window. The runoff model makes the catchment’s natural flow; the network then routes it through hydrological units and dams to the outflow gauge, where the EWR and the calibration are checked.'
					},
					{
						type: 'steps',
						items: [
							'**Rain.** Each day takes the first available of catchment rain, bias-corrected CHIRPS and forecast rain. See [[guide:rain-gap-filling|How rain gaps are filled]].',
							'**Natural flow.** The [[runoff-model]] (GR4J) turns rain and evaporation into the flow the catchment would produce with no hydrological units.',
							'**Shares.** Natural flow and the EWR are split between the hydrological units by fixed [[flow-share|flow shares]].',
							'**Demand.** Crops, A-pan and effective rain give each hydrological unit’s [[crop-requirement|crop water requirement]]; divided by the [[irrigation-efficiency|irrigation efficiency]] it is the [[irrigation-demand|abstraction demand]], what the hydrological unit takes from its dam and the river.',
							'**Hydrological unit balance.** Upstream first, each hydrological unit fills its dam, irrigates, spills and passes water on. See [[guide:a-day-on-a-farm|A day on one hydrological unit]].',
							'**Outlet.** The outflow gauge’s flow is the simulated outflow. It is checked against the EWR and scored against observed flow. Every other gauge is an EWR site too, and a shortfall at any site is charged to the hydrological units upstream of it ([[ewr-charge]]).'
						]
					}
				]
			},
			{
				heading: 'Properties you can rely on',
				blocks: [
					{
						type: 'list',
						items: [
							'Flows and volumes are m³/day inside the model. Nothing is rounded mid-calculation; rounding is for display only.',
							'Every hydrological unit’s daily balance closes: inflow + rain on the dam − irrigation use − dam evaporation − change in storage = outflow. Invariant tests check this on random networks, and every run checks it again on its own results (**Self-checks**).',
							'A run is a snapshot: it records its inputs and engine version, so its results can always be explained and reproduced.',
							'Where the engine departs from the b023 workbook, the engine audit records why.'
						]
					}
				]
			}
		],
		terms: ['water-balance', 'natural-flow', 'farm-runoff', 'farm-outflow'],
		related: ['a-day-on-a-farm', 'how-gr4j-works', 'rain-gap-filling']
	},
	{
		id: 'a-day-on-a-farm',
		title: 'A day on one hydrological unit',
		summary: 'How a hydrological unit element splits its inflows around the dam, irrigates, spills and passes water downstream.',
		kind: 'concept',
		tab: 'network',
		sections: [
			{
				heading: 'One hydrological unit, up close',
				blocks: [
					{
						type: 'picture',
						shot: 'farm',
						caption: 'A hydrological unit (here a farm) on a tributary: its dam, the orchard it irrigates and the pipeline to a neighbour’s dam. Follow the numbers in the order the model works through a day.',
						stops: [
							{ spot: 'upstream', title: 'Inflow from upstream', text: 'The stream brings the outflow of the elements above. The [[upstream-to-dam|upstream share]] of it enters the dam.' },
							{ spot: 'runoff', title: 'The hydrological unit’s own runoff', text: 'The hydrological unit’s [[flow-share|share]] of the catchment’s natural flow. Its [[runoff-to-dam|own-runoff share]] drains into the dam.' },
							{ spot: 'storage', title: 'Dam storage', text: 'Yesterday’s storage plus rain on the dam, today’s captured inflow, diversion and transfers, less [[dam-evaporation|evaporation]], [[dam-seepage|seepage]] and irrigation, up to the [[dam-capacity|capacity]].' },
							{ spot: 'spill', title: 'Spill over the wall', text: 'Water above capacity [[spill|spills]] and continues downstream the same day.' },
							{ spot: 'irrigation', title: 'Irrigation draw', text: 'The dam supplies the hydrological unit’s [[irrigation-demand|irrigation demand]], or what it holds above its [[dam-min|minimum level]] if that is less.' },
							{ spot: 'crops', title: 'The crops', text: 'The crop gets the supply × the [[irrigation-efficiency|irrigation efficiency]]. Part of the losses runs back to the river as [[return-flow|return flow]]; the rest leaves the catchment.' },
							{ spot: 'transfer', title: 'Transfer to a neighbour', text: 'A [[transfer]] can move water out of (or into) this dam in chosen months.' },
							{ spot: 'outflow', title: 'Outflow', text: 'Spill, water that passed below the dam, seepage and return flow leave as the hydrological unit’s [[farm-outflow|outflow]], the next element’s inflow.' }
						]
					}
				]
			},
			{
				heading: 'Around the dam',
				blocks: [
					{
						type: 'diagram',
						id: 'farm-day',
						caption:
							'Water arriving from upstream and the hydrological unit’s own runoff each split into a part that enters the dam and a part that passes below it. A diversion can take some of the bypass back into the dam. Irrigation draws from the dam; spill, bypass and return flow leave downstream.'
					},
					{
						type: 'steps',
						items: [
							'Upstream inflow × [[upstream-to-dam|upstream share]] enters the dam; the rest passes below it.',
							'Hydrological unit runoff × [[runoff-to-dam|own-runoff share]] enters the dam; the rest passes below it.',
							'The [[diversion]] takes up to its daily capacity from the water passing below, back into the dam.',
							'A [[transfer]] adds to or takes from the dam. Transfers move first, before any hydrological unit irrigates.',
							'The dam catches the rain on its surface and loses [[dam-evaporation|open-water evaporation]] and any [[dam-seepage|seepage]]; seepage reaches the river below the wall.',
							'Irrigation takes the smaller of the [[irrigation-demand|demand]] and what the dam holds above its [[dam-min|minimum level]] (yesterday’s storage plus today’s inflows and the rain on it, less evaporation and seepage).',
							'Storage above capacity [[spill|spills]]. [[return-flow|Return flow]] is the share of the irrigation water supplied that returns to the river the same day (never more than the losses).',
							'Outflow = spill + water passing below the dam not diverted + seepage + return flow. It is the next element’s upstream inflow.'
						]
					}
				]
			},
			{
				heading: 'The balance',
				blocks: [
					{
						type: 'formula',
						text: 'upstream inflow + runoff + transfer + rain on the dam − (irrigation − return flow) − dam evaporation − Δ storage = outflow'
					},
					{
						type: 'p',
						text: 'It closes to the cubic metre every day ([[balance-check|the balance check]]). Seepage is part of the outflow, so it stays in the catchment.'
					}
				]
			}
		],
		terms: ['dam-storage', 'dam-evaporation', 'irrigation-efficiency', 'irrigation-supplied', 'irrigation-deficit'],
		related: ['how-the-model-works', 'build-the-network']
	},
	{
		id: 'how-gr4j-works',
		title: 'How GR4J turns rain into flow',
		summary: 'Two stores and two unit hydrographs, four parameters, and a water balance that always closes.',
		kind: 'concept',
		tab: 'settings',
		sections: [
			{
				heading: 'Under the ground',
				blocks: [
					{
						type: 'picture',
						shot: 'soil',
						caption: 'The cut face of the catchment beside the river. GR4J is a conceptual model: its two stores stand roughly for the moist soil and the groundwater, not for measured layers.',
						stops: [
							{ spot: 'rain', title: 'Rain', text: 'Rain first meets evaporation. What is left is net rain.' },
							{ spot: 'evaporation', title: 'Evaporation', text: 'Plants and soil return water to the air, up to the [[pan-coefficient|potential evaporation]].' },
							{ spot: 'soil', title: 'The soil store (X1)', text: 'Net rain partly fills the production store. A larger X1 holds more rain back, so less of it becomes flow.' },
							{ spot: 'groundwater', title: 'The routing store (X3)', text: 'Water that percolates on is released slowly. A larger X3 means slower, longer recessions between storms.' },
							{ spot: 'river', title: 'Flow in the river', text: 'The routing store’s release plus a quick direct part is the [[natural-flow]]; X4 sets how many days a storm takes to arrive.' }
						]
					}
				]
			},
			{
				heading: 'The structure',
				blocks: [
					{
						type: 'diagram',
						id: 'gr4j',
						caption:
							'GR4J (Perrin et al. 2003). Rain first meets evaporation. What is left partly fills the soil (production) store; the rest, with what percolates out of it, is spread in time by two unit hydrographs. 90 % passes through the routing store, 10 % goes directly to the outlet.'
					},
					{
						type: 'list',
						items: [
							'**X1** (mm): capacity of the soil-moisture store. Larger means more rain is held and evaporated, so less flow. Typical 100–1 200.',
							'**X2** (mm/day): exchange with groundwater outside the catchment. Fixed at 0 by default, so the catchment is closed.',
							'**X3** (mm): capacity of the routing store. Larger means slower, longer recessions. Typical 20–300.',
							'**X4** (days): time base of the unit hydrographs, the timing of the peak. Typical 1.1–2.9.'
						]
					}
				]
			},
			{
				heading: 'Forcing and warm-up',
				blocks: [
					{
						type: 'p',
						text: 'Rain is the gap-filled catchment rain, with no rain threshold. Potential evaporation is the monthly [[pan-coefficient]] × A-pan, spread over the days of the month. A warm-up (a year by default) runs over the start of the record first, so the stores begin at a realistic level; warm-up days are never shown or scored.'
					},
					{
						type: 'formula',
						text: 'rain − actual evaporation − flow − groundwater exchange = change in storage   (every day)'
					},
					{
						type: 'p',
						text: 'The **Runoff model** panel on a GR4J run shows this balance in mm and as a share of rain. It is the first thing to check when a fit looks too wet or too dry.'
					}
				]
			}
		],
		terms: ['gr4j', 'actual-evaporation', 'pan-coefficient', 'runoff-model'],
		related: ['how-calibration-works', 'calibrate-by-hand']
	},
	{
		id: 'how-calibration-works',
		title: 'How calibration works',
		summary:
			'What is scored, how the optimiser searches, and why validation on unseen days matters more than the fit.',
		kind: 'concept',
		tab: 'settings',
		sections: [
			{
				heading: 'What is scored',
				blocks: [
					{
						type: 'picture',
						shot: 'weir',
						caption: 'The catchment outlet. The observed record comes from here; the model’s simulated outflow is its prediction of the same place.',
						stops: [
							{ spot: 'gauge', title: 'The gauging hut', text: 'A gauge or logger records the water level, turned into [[observed-flow|observed flow]] by a rating curve. High flows beyond the highest measurement are extrapolated, so they are the least certain.' },
							{ spot: 'weir', title: 'The weir', text: 'A control that makes level and flow relate reliably. The model’s [[outflow-gauge]] stands for this point.' },
							{ spot: 'reach', title: 'The river above it', text: 'What arrives here is the whole catchment’s outflow, hydrological units and dams included, which is why the whole model is scored, not the runoff model alone.' }
						]
					},
					{
						type: 'p',
						text: 'An observed gauge or logger measures the river as it is, with its hydrological units and dams. So every candidate parameter set runs the **whole model** (runoff model, then the network) and scores the simulated outflow against the observed record. The fitted parameters describe the natural catchment; the network adds the impacts.'
					},
					{
						type: 'p',
						text: 'Scored days are days with an observation, inside the [[calibration-window]], outside every [[calibration-exclusions|exclusion]], and not left out by the [[quality-flags|quality flags]] (by default days below the lowest gauging, suspect and infilled days; days above the highest gauging are censored). At least 30 are needed.'
					}
				]
			},
			{
				heading: 'The search',
				blocks: [
					{
						type: 'diagram',
						id: 'calibration-loop',
						caption:
							'Fit automatically. DDS starts from the current parameters, perturbs them within their bounds, runs the whole model and keeps a candidate only when it scores better. By default it tries 1 500 candidates per search.'
					},
					{
						type: 'p',
						text: 'The optimiser is DDS (Tolson & Shoemaker 2007). Early on it perturbs every parameter; later it changes fewer, homing in on the best set found. Candidates are always kept within the [[calibration-bounds|bounds]]. The search is deterministic for a seed: the same data, engine version and seed give the same fit. The app runs five searches (starts) from different seeds and keeps the best; when several reach nearly the same score with scattered parameters, the notes say the record can’t pin those parameters down.'
					},
					{
						type: 'list',
						items: [
							'**KGE′** (default): correlation, bias and variability in one score, less peak-dominated than NSE.',
							'**Year-balanced KGE′**: each water year counts once, so a few wet years can’t dominate a drought-heavy record.',
							'**Non-parametric KGE**: rank correlation, the flow-duration curve’s shape and the bias, so less sensitive to rating error at the extremes.',
							'**NSE on √Q** (medium flows) and **NSE on log Q** (low flows).',
							'**Mean of KGE′(Q) and KGE′(1/Q)**: half the score on the flows, half on their inverses, so recessions and low flows count as much as the peaks. Suggested when the fit feeds an EWR (low-flow) decision.'
						]
					},
					{
						type: 'p',
						text: 'Choose the [[calibration-objective|objective]] by what the fit will feed, before seeing any score, never by which one scores best: scores of different objectives don’t compare.'
					}
				]
			},
			{
				heading: 'Validation: the honest measure',
				blocks: [
					{
						type: 'diagram',
						id: 'validation',
						caption:
							'Each test fits on one part of the record and scores another part it never saw. The dry → wet test fits on the driest water years and scores the wettest, which is the hardest test for a catchment used in drought.'
					},
					{
						type: 'list',
						items: [
							'**Split-sample** (Klemeš 1986): fit on the first half of the scored days, score the second half.',
							'**Dry → wet**: with at least 4 water years of 180 or more observed days, fit on the driest half and score the wettest half.',
							'**Independent record** (optional): score the fitted parameters against the second instrument, for example the logger when the fit used the gauge.'
						]
					},
					{
						type: 'p',
						text: 'The result adds plain-language notes on its limits: too few years to test wet years, wet years barely wetter than dry ones, or a validation score more than 0.2 below its calibration score. A short record that is mostly drought gets these notes rather than a clean bill of health.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'A fit that scores well in-sample but poorly in validation usually means the record can’t pin the parameters down, not that the optimiser failed. More model runs won’t help; more varied data, typical bounds or a WR2012 check will.'
					}
				]
			}
		],
		terms: ['auto-calibration', 'fit-record', 'kge', 'nse', 'log-nse', 'pbias'],
		related: ['fit-automatically', 'calibrate-by-hand', 'check-against-wr2012']
	},
	{
		id: 'rain-gap-filling',
		title: 'How rain gaps are filled',
		summary: 'Which rain series a day uses, and how CHIRPS is bias-corrected to the catchment before it fills a gap.',
		kind: 'concept',
		tab: 'series',
		sections: [
			{
				heading: 'One value per day',
				blocks: [
					{
						type: 'diagram',
						id: 'rain-sources',
						caption:
							'Each day takes the first series that has a value. CHIRPS is scaled by its calendar month’s catchment ÷ CHIRPS factor before it is used. A day with no value anywhere is treated as dry, and the run counts those days.'
					},
					{
						type: 'p',
						text: 'A 0 is a reading, so it blocks the fallback. Long wet-season runs of zeros that the **Data checks** flag are the exception: by default a run treats them as blank, so CHIRPS fills them ([[zero-rain-runs|zero-rain runs]]). On **Settings & calibration → Rain gaps** you can keep a confirmed dry spell dry, run every flagged run as recorded, or list other bad periods to treat as missing. The uploaded series is never changed.'
					},
					{
						type: 'p',
						text: 'A large reading after days of 0 or blank, on a day CHIRPS reads little although it saw rain over those days, looks like several days read at once ([[rain-accumulations|a multi-day accumulation]]). By default a run keeps its recorded total and spreads it over the days it covers in proportion to bias-corrected CHIRPS. More than 7 blank days in a row is an outage: such a reading straight after one is set aside and CHIRPS fills its day, since it may hold weeks of rain or one day’s. Under **Multi-day accumulations** on the same panel you can run them as recorded, keep readings you know were one day’s rain, or list accumulations the check misses.'
					},
					{
						type: 'p',
						text: 'The result is the [[rain-final|final catchment rainfall]], which both runoff models and the effective-rain part of demand use. The daily CSV export puts it beside CHIRPS as uploaded and bias-corrected CHIRPS, so filled days can be checked.'
					}
				]
			},
			{
				heading: 'The CHIRPS factors',
				blocks: [
					{
						type: 'formula',
						text: 'factor(month) = Σ catchment rain ÷ Σ CHIRPS   over the days of that calendar month that have both'
					},
					{
						type: 'list',
						items: [
							'Water years that read far below CHIRPS are left out whole, and so are the days of flagged zero runs (unless kept dry), of periods listed as missing and of multi-day accumulations, because their catchment rain is suspect.',
							'A month with fewer than 90 shared days, or under 50 mm of CHIRPS on them, uses the factor pooled over all months.',
							'Factors are kept between 0.25 and 4. Each run lists them in its warnings and the summary CSV.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Choose **Raw CHIRPS** only when the series you loaded is already corrected to the catchment; otherwise it is corrected twice.'
					}
				]
			}
		],
		terms: ['rain-catchment', 'chirps', 'chirps-bias', 'zero-rain-runs', 'rain-forecast'],
		related: ['add-data', 'how-the-model-works']
	},
	{
		id: 'curtailment-targets',
		title: 'Curtailment targets',
		summary: 'How the app compares each hydrological unit’s supply with a fairness benchmark and works out the cut that meets the EWR.',
		kind: 'concept',
		tab: 'supply',
		sections: [
			{
				heading: 'The idea',
				blocks: [
					{
						type: 'p',
						text: 'Over the [[report-window|reporting window]], add up what every hydrological unit asked for and what it received. Their ratio is the catchment’s [[equitable-share|equitable share of supply]] (a **fairness benchmark**): had the supplied water been shared in proportion to demand, every hydrological unit would have received that fraction.'
					},
					{
						type: 'formula',
						text: 'equitable share volume = demand × Σ supplied ÷ Σ demand          above (−) / below (+) equitable share = equitable share volume − supplied'
					},
					{
						type: 'p',
						text: 'The differences cancel across the hydrological units, so this only compares; a positive value is not water the hydrological unit can get. Each hydrological unit’s [[ewr-charge|EWR charge]] (its share of the shortfall at the EWR sites below it) is then split into [[ewr-charge-split|irrigating less and storing less]], and the supply cut for the irrigation part is added: the **total change** in supply. Negative means reduce. The volume left never goes below 0, nor below the hydrological unit’s [[basic-needs-floor|basic-needs floor]] (25 litres a person a day for the people its domestic and municipal demands serve); what the floor keeps of the cut is shown in its row.'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'The equitable share is a fairness benchmark only: it assumes water can move freely between hydrological units, and ignores network position, storage, licences and existing lawful use. Not an allocation or licence condition.'
					}
				]
			}
		],
		terms: ['irrigation-demand', 'irrigation-supplied', 'pragmatic-ewr', 'equitable-share', 'ewr-charge', 'ewr-charge-split', 'demand-left', 'basic-needs-floor'],
		related: ['set-the-ewr', 'run-and-read-results']
	},
	// ---- Pages, one by one ----------------------------------------------------
	// What each workspace page is for and how to work it; the page's section
	// header links here ("How this page works", TAB_GUIDE in lib/workspace/tabs.ts).
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
							'Under **Add a change**, add each change in turn. Each reads in words against the value it meets (“dam capacity 120 000 → 144 000 m³”), so a second change to the same value shows the first one’s result as “was”.',
							'Read the label on each change: a **Proposal** is the change being assessed; a **Baseline assumption** changes what the river is like today (rain, a setting, a Reserve rule) and puts a red **Baseline assumptions changed** callout above the list.',
							'Press **Run scenario**. The run joins Runs & results tagged **Scenario**, and **Scenario against its base** shows the headline water balance and each hydrological unit against the base run.',
							'To bring an older scenario up to date, **Rebase onto another run**: **Check** lists any change that no longer applies, then **Rebase onto this run**.'
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
						text: 'Two sides use it. The **applicant** (the developer, the farmer or their consultant) builds and submits it. The **assessors** are the project’s owners and editors, who read it and record a decision.'
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
							'Open one to read its changes and runs in Scenarios, answer the applicant’s questions about rules they can’t see, and record the decision with its reasons.',
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
						text: 'Each water user in the catchment is registered (WARMS) or licensed for a volume a year. This page sets those volumes beside what a run modelled each hydrological unit using, per water year, so you can see where modelled use runs above or below the registration.'
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
							'Turn the page on in **Choose sections** if it is hidden.',
							'Press **Import** and upload a WARMS extract or a CSV (**Download the CSV template** shows the columns). A WARMS extract asks how you obtained it; the preview says how many rows matched a hydrological unit.',
							'Or press **+ Add volume** for one at a time: a take from the river or a borehole, or a dam’s storage.',
							'Match any volume the header counts as “not matched” to its hydrological unit.',
							'Pick the run to compare with in the header’s run menu, and read each unit’s modelled use against its registered volume.'
						]
					},
					{
						type: 'p',
						text: 'Under Settings, an [[allocation-mode]] can make a run cap each unit’s use at its registered volume, or take every registered volume in full; this page then says what the run did.'
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
							'A dam’s registered storage (a [[s21-water-use|s21(b) row]]) is set against the dam’s modelled capacity, never against the year’s use ([[registered-storage]]).',
							'After a cap run, the picked unit says on how many days the cap held use back, and why ([[cap-held-back]]).'
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
							'An accepted boundary is on the map only, not in the model yet. Its card, and the message after accepting, offer the next step: **Divide the model** splits it into each unit’s area at your dams, abstraction points and gauges (**Start from the map** while the model is empty), each value ticked to take it.',
							'While the model is empty, **Start from the map** proposes the units, their areas and their order from the boundary and the points; each value is ticked to take it.',
							'With water occurrence data on the server, **Trace a dam** proposes a dam’s outline from a click inside it.',
							'**Measure** and **Download GeoJSON** are there for everyone, viewers too.'
						]
					}
				]
			}
		],
		terms: ['catchment-map', 'delineation', 'map-area', 'area-basis', 'map-checks', 'map-results', 'quaternary', 'farm-area'],
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
						text: 'Levels are shares of the capacity on the day, so a dam losing capacity to [[dam-sediment|sediment]], or coming into service part way through the record, reads correctly. **Open in Runs** goes to the run the page shows.'
					}
				]
			}
		],
		terms: ['dam-storage', 'dam-capacity', 'dam-min', 'dam-evaporation', 'spill'],
		related: ['run-and-read-results', 'a-day-on-a-farm']
	},
	{
		id: 'river-page',
		title: 'River & reserve: is enough left in the river?',
		summary: 'One run’s river against its Ecological Reserve: the days the EWR was not met, the water account and how this run differs from the one before.',
		kind: 'page',
		tab: 'river',
		sections: [
			{
				heading: 'What the page shows',
				blocks: [
					{
						type: 'p',
						text: 'One run’s river against its [[ewr]]: tiles for the share of days the EWR was not met at the outflow gauge ([[ewr-days-not-met]]), each with its change from the run before; the flow chart against the EWR; [[reserve-compliance|Reserve compliance]] at each EWR site; and the [[water-account]] of where the catchment’s water went.'
					},
					{
						type: 'p',
						text: 'The page shows the newest run; pick another with the **Run** menu in the header (Back returns to the one before). **Open in Runs & results** opens the same run there.'
					}
				]
			}
		],
		terms: ['ewr', 'ewr-days-not-met', 'reserve-compliance', 'water-account', 'pragmatic-ewr'],
		related: ['set-the-ewr', 'run-and-read-results']
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
						text: 'One card per hydrological unit with the share of its [[irrigation-demand]] the run supplied, beside the picked unit’s chart. The header counts the units and how many were short this week. Tiles give the catchment’s [[irrigation-supplied]] and how many units fell below 95 %.'
					},
					{
						type: 'p',
						text: 'Below the cards: the curtailment panel with its reporting window and share-the-pain board ([[guide:curtailment-targets]]), and [[assurance-of-supply]]. Pick another run with **Run shown** in the header.'
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
							'**The model**: headline facts (units, gauges, catchment area, dams, irrigated area, transfers, series, runs), each linking to where it is edited.',
							'**Download** in the header: the whole project as one JSON file (model, settings and input series), for every member.',
							'**Members**: who can open the project and with which [[roles|role]]. Owners add people and change roles.',
							'**Farmers**: which hydrological units each farmer is linked to; a farmer reads only their own.',
							'**Share links**: read-only links for people outside the project, to the published baseline.'
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
		terms: ['roles', 'published-baseline', 'project'],
		related: ['create-a-project', 'applications-page']
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
		related: ['project-page']
	}
];

/** The setup path on the /help landing page: one step per workspace tab. */
export const SETUP_STEPS: { tab: TabId; text: string; guide: string; optional?: boolean }[] = [
	{ tab: 'overview', text: 'Create a project, or copy one for a what-if.', guide: 'create-a-project' },
	{ tab: 'network', text: 'Hydrological units, dams and gauges, draining to one outlet.', guide: 'build-the-network' },
	{ tab: 'crops', text: 'Crop factors and the hectares on each hydrological unit.', guide: 'set-up-crops-and-demand', optional: true },
	{ tab: 'transfers', text: 'Pipelines or canals between hydrological units’ dams.', guide: 'add-a-transfer', optional: true },
	{ tab: 'series', text: 'Daily rain, and observed flow to calibrate.', guide: 'add-data' },
	{ tab: 'settings', text: 'Evaporation, rain gaps, runoff parameters and the EWR.', guide: 'fit-automatically' },
	{ tab: 'runs', text: 'Run the model, read and compare results.', guide: 'run-and-read-results' }
];

// ---------------------------------------------------------------------------
// Lookup, inline markup and search
// ---------------------------------------------------------------------------

const byId = new Map(GUIDES.map((g) => [g.id, g]));

const norm = (s: string) =>
	s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();

export function guideFor(id: string): Guide | undefined {
	return byId.get(id);
}

/** In-page anchor for a guide section, from its heading. */
export function sectionId(heading: string): string {
	return norm(heading)
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

export type InlinePart =
	| { kind: 'text'; text: string }
	| { kind: 'strong'; text: string }
	| { kind: 'em'; text: string }
	/** A glossary entry (`id`) or a guide (`guide`), with its label. */
	| { kind: 'term'; id: string; text: string }
	| { kind: 'guide'; id: string; text: string }
	/** A reference that doesn't resolve: shown as plain text (and failed by the tests). */
	| { kind: 'broken'; ref: string; text: string };

// *italics* only where the asterisks stand apart from a word (a space,
// punctuation or the ends either side), so 5*3 or a*b stays as written.
const INLINE = /\*\*(.+?)\*\*|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g;

/**
 * A glossary term as it reads mid-sentence: an ordinary capitalised first
 * word is lowercased ("Runoff model" → "runoff model"); acronyms and names
 * (EWR, CHIRPS, GR4J, A-pan, NSE) are left alone. Give a [[id|label]] when a
 * link starts a sentence.
 */
export function inSentence(term: string): string {
	return /^[A-Z][a-z]+(?![-\w])/.test(term) ? term[0]!.toLowerCase() + term.slice(1) : term;
}

/** Splits guide text into plain text, bold UI labels, italics and links. */
export function inline(text: string): InlinePart[] {
	const out: InlinePart[] = [];
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
		last = m.index + m[0].length;
		if (m[1] !== undefined) {
			out.push({ kind: 'strong', text: m[1] });
			continue;
		}
		if (m[4] !== undefined) {
			out.push({ kind: 'em', text: m[4] });
			continue;
		}
		const ref = m[2]!.trim();
		const label = m[3]?.trim();
		if (ref.startsWith('guide:')) {
			const g = guideFor(ref.slice(6));
			out.push(g ? { kind: 'guide', id: g.id, text: label ?? g.title } : { kind: 'broken', ref, text: label ?? ref });
		} else {
			const e = helpFor(ref);
			out.push(e ? { kind: 'term', id: e.id, text: label ?? inSentence(e.term) } : { kind: 'broken', ref, text: label ?? ref });
		}
	}
	if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
	return out;
}

/** Guide text with the markup removed (for search). */
export function plainText(text: string): string {
	return inline(text)
		.map((p) => p.text)
		.join('');
}

function blockText(b: GuideBlock): string {
	switch (b.type) {
		case 'steps':
		case 'list':
			return b.items.map(plainText).join(' ');
		case 'diagram':
			return b.caption;
		case 'picture':
			return [b.caption, ...b.stops.map((s) => `${s.title} ${plainText(s.text)}`)].join(' ');
		default:
			return plainText(b.text);
	}
}

/**
 * Guides matching every word of `query`, best first: title matches before
 * summary matches before body matches. Empty query → no guides (the page
 * lists them itself).
 */
export function searchGuides(query: string, guides: readonly Guide[] = GUIDES): Guide[] {
	const words = norm(query).split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const scored: { g: Guide; score: number; i: number }[] = [];
	guides.forEach((g, i) => {
		const title = norm(g.title);
		const summary = norm(g.summary);
		const body = norm(g.sections.flatMap((s) => [s.heading, ...s.blocks.map(blockText)]).join(' '));
		let score = 0;
		for (const w of words) {
			if (title.includes(w)) score += 3;
			else if (summary.includes(w)) score += 2;
			else if (body.includes(w)) score += 1;
			else return;
		}
		scored.push({ g, score, i });
	});
	return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.g);
}
