// The places the engine deliberately departs from the spreadsheet it replaced,
// as the public methods page (/methods) states them: a plain summary of the
// findings of docs/engine-audit.md. Each entry names its audit ids, and
// departures.test.ts checks every id is a row of the audit. Whether a decision
// is settled or still waits on a hydrologist is not written here: the page
// reads it from the engine's generated known limitations, so it can't go stale.

export interface Departure {
	/** The audit ids this entry summarises (engine-audit.md's Findings or quirk tables). */
	ids: string[];
	/** What the spreadsheet did. */
	was: string;
	/** What the engine does instead, and why. */
	now: string;
}

export const DEPARTURES: readonly Departure[] = [
	{
		ids: ['H1'],
		was: 'Its runoff model could return several times a small storm’s rain as flow over the following year, and small storms returned relatively more than large ones.',
		now: 'GR4J, a published daily rainfall–runoff model that conserves water, is the only runoff model. Every runoff model must pass an event-scale check: no storm returns more water than fell.'
	},
	{
		ids: ['R1'],
		was: 'It rounded almost every column, so recessions stopped at a floor in a drought, splitting a small flow created or destroyed water, and small dams vanished.',
		now: 'The model keeps full precision throughout. Only the screens and exports round, for display.'
	},
	{
		ids: ['G1'],
		was: 'A gauge where two branches meet added up its branches’ shortfalls, so a short branch and a spare one reported a shortfall the river didn’t have.',
		now: 'A gauge’s shortfall is judged on the flow that actually reaches it, the same definition as everywhere else.'
	},
	{
		ids: ['Q17', 'Q13'],
		was: 'Shortfalls below the Ecological Reserve were handed down the network in a way that didn’t add up, and a hydrological unit with no irrigation could be told to cut supply.',
		now: 'Each shortfall at a Reserve site is shared among the hydrological units upstream in proportion to their net effect on the river, and split into what cutting irrigation can fix and what only releasing water can.'
	},
	{
		ids: ['N1'],
		was: 'Water that returned to the river from irrigation was taken off the crop’s own requirement, so a crop reported as fully supplied was short.',
		now: 'Each hydrological unit has an irrigation efficiency: abstraction is the crop’s requirement divided by it, and a set share of the losses returns to the river.'
	},
	{
		ids: ['N2'],
		was: 'Farm dams lost nothing to evaporation or seepage, overstating summer storage exactly when irrigation draws on it.',
		now: 'Each dam evaporates from a surface that shrinks as it empties, gains the rain that falls on it, and may seep.'
	},
	{
		ids: ['N3'],
		was: 'Rain offset irrigation demand only on the day it fell; the rest of a heavy rain was lost.',
		now: 'A small soil-water store carries useful rain over to the following days (set to 0 it reproduces the spreadsheet exactly).'
	},
	{
		ids: ['N4', 'Q3', 'Q18'],
		was: 'Water pumped into a full dam spilled straight away, and several transfers from one dam depended on the order they were listed in.',
		now: 'A transfer is capped at the receiving dam’s room, and transfers run by priority, sharing a dam fairly whatever their order.'
	},
	{
		ids: ['B2'],
		was: 'Missing rain recorded as zeros ran the catchment dry.',
		now: 'Suspicious runs of zeros are treated as missing and filled from corrected satellite rain, unless someone confirms they were really dry.'
	},
	{
		ids: ['B1', 'B4', 'D1'],
		was: 'Gaps in the catchment rain were filled with raw satellite rain (CHIRPS), several days’ rain logged on one day was taken as one storm, and a run could cover years with no rain record at all.',
		now: 'Satellite rain is corrected month by month against the catchment’s own gauges before it fills a gap, multi-day totals are spread over the days they cover, and the run starts and ends where the rain record does.'
	},
	{
		ids: ['P1', 'C1'],
		was: 'It could fall back on a second model’s monthly flow (Pitman) on days the rain model gave nothing, and score the runoff model against it.',
		now: 'Natural flow comes only from the runoff model, and calibration only uses measured flow.'
	},
	{
		ids: ['Q1'],
		was: 'The share of upstream inflow entering a dam was applied the wrong way round.',
		now: 'It means what its label says.'
	},
	{
		ids: ['F1'],
		was: 'A rain forecast past the end of the record reached every summary, so yesterday’s forecast changed the figures people rely on.',
		now: 'Summaries cover the recorded period only; a forecast is shown separately, over its own days.'
	},
	{
		ids: ['M1'],
		was: 'A lookup matched “11” and “12” inside other month numbers, so November also meant January.',
		now: 'Month lists mean exactly the months they name.'
	},
	{
		ids: ['W1–W5'],
		was: 'Impossible or silently patched inputs gave no warning.',
		now: 'The run warns about them: more runoff than rain, days with no rain value, hydrological unit areas that don’t add up.'
	}
];

/** The ids of a departure whose decision is still open: listed in the engine's known limitations. */
export function openIds(d: Departure, open: readonly { id: string }[]): string[] {
	const ids = new Set(open.map((l) => l.id));
	return d.ids.filter((id) => ids.has(id));
}
