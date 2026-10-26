// The places in the app a run's warnings send the reader to (issue #586, D19):
// "Model settings → Rain gaps → Flagged rain", or
// "Calibration → Plausibility checks". A warning stays a plain sentence (it is stored on the run, printed
// in the report and written to the summary CSV), and names each place as
// "<page> → <panel>", with the panel's heading word for word. placesIn finds
// those names in a warning's text, so the app can make them links to the panel
// without the warning carrying anything but its words; it also finds the names
// runs made before engine 1.98.0 used ("Settings → Calibration record", "The
// Plausibility checks panel"), so their warnings link too, to the panel's
// place now. Words only: which page and anchor a place is lives in the app. The
// one value import is quality.ts's seriesCheckInCurrentWords (engine 1.99.0 day-first dates).
import { seriesCheckInCurrentWords } from './quality';

/** Each place a warning names: the page it is on and the panel's heading there. */
export const WARNING_PLACES = {
	period: { page: 'Model settings', panel: 'Simulation period' },
	rain: { page: 'Model settings', panel: 'Rain gaps' },
	quality: { page: 'Model settings', panel: 'Data quality' },
	demand: { page: 'Model settings', panel: 'Demand' },
	share: { page: 'Model settings', panel: 'Flow generation' },
	reserve: { page: 'Model settings', panel: 'Reserve rule tables' },
	evidence: { page: 'Model settings', panel: 'Evidence' },
	flow: { page: 'Calibration', panel: 'Flow calibration' },
	record: { page: 'Calibration', panel: 'Calibration record' },
	fit: { page: 'Calibration', panel: 'Fit the parameters' },
	wr2012: { page: 'Calibration', panel: 'WR2012 check' },
	plausibility: { page: 'Calibration', panel: 'Plausibility checks' }
} as const;

export type WarningPlace = keyof typeof WARNING_PLACES;

/** The arrow between a place's steps. */
export const PLACE_STEP = ' → ';

/** A place as a warning names it: "Calibration → Fit the parameters", then any steps inside the panel. */
export function placeName(key: WarningPlace, ...within: string[]): string {
	const p = WARNING_PLACES[key];
	return [p.page, p.panel, ...within].join(PLACE_STEP);
}

/** One place named in a warning: where its name starts and ends in the text, and which place it is. */
export interface PlaceMention {
	start: number;
	end: number;
	place: WarningPlace;
}

/** The ways a place has been named: as now, then as runs before engine 1.98.0 did ("Settings → Rain gaps", "Settings › Evidence"). */
function spellings(key: WarningPlace): string[] {
	const { panel } = WARNING_PLACES[key];
	const old = key === 'plausibility' ? ['The Plausibility checks panel', 'the Plausibility checks panel'] : [`Settings${PLACE_STEP}${panel}`, `Settings › ${panel}`];
	return [placeName(key), ...old];
}

const SPELLINGS: readonly { text: string; place: WarningPlace }[] = (Object.keys(WARNING_PLACES) as WarningPlace[])
	.flatMap((place) => spellings(place).map((text) => ({ text, place })))
	// Longest first, so "Model settings → Data quality" wins over any shorter name inside it.
	.sort((a, b) => b.text.length - a.text.length);

/**
 * The places a warning names, in the order they appear, none overlapping: the "<page> → <panel>" part of each
 * (a link's text; the steps after it stay plain). A panel named inside a sentence without its page ("the
 * Calibration record's window") is not a place.
 */
export function placesIn(text: string): PlaceMention[] {
	const found: PlaceMention[] = [];
	for (const { text: name, place } of SPELLINGS) {
		for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
			const end = at + name.length;
			// The panel's name ends there: "Settings → Demand" is not "Settings → Demands".
			if (/[\p{L}\p{N}]/u.test(text[end] ?? '')) continue;
			if (found.some((f) => at < f.end && end > f.start)) continue;
			found.push({ start: at, end, place });
		}
	}
	return found.sort((a, b) => a.start - b.start);
}

/** Words a warning used before engine 1.98.0 for a place that has no "Settings → " name, each with its words now. */
const OLD_WORDS: readonly [string, string][] = [
	['Set the monthly A-pan (Settings)', `Set the monthly A-pan (${placeName('demand')})`],
	['the high/low MAP split (Settings)', `the high/low MAP split (${placeName('share')})`],
	['the monthly PE row (Settings)', `the monthly PE row (${placeName('flow')})`],
	['not the catchment area set in Settings (', `not the catchment area set in ${placeName('flow')} (`],
	['no WR2012 reference in Settings, so', `no WR2012 reference (${placeName('wr2012')}), so`],
	['there is no WR2012 reference in Settings.', `there is no WR2012 reference (${placeName('wr2012')}).`],
	['enter it on the rule table in Settings.', `enter it on the rule table (${placeName('reserve')}).`],
	['Validation signatures (provisional limits):', 'Hydrological signatures (provisional limits):']
];

/**
 * A warning in the words the engine uses today: each place by its name now ("Settings → Calibration record" →
 * "Calibration → Calibration record"), the validation signatures as hydrological, and no repository document
 * cited (engine 1.98.0, issue #586 D19, D17); a data check's dates day first (engine 1.99.0,
 * seriesCheckInCurrentWords). For comparing an older run's warnings with a newer one's (auto-publish's "no new
 * warning"): the same warning in the old words reads the same. A warning already in today's words is unchanged.
 */
export function warningInCurrentWords(text: string): string {
	let out = seriesCheckInCurrentWords(text).replace(/ \(docs\/model\.md §[^)]*\)/g, '');
	for (const [old, now] of OLD_WORDS) out = out.split(old).join(now);
	const marks = placesIn(out);
	for (let i = marks.length - 1; i >= 0; i--) {
		const m = marks[i]!;
		out = out.slice(0, m.start) + placeName(m.place) + out.slice(m.end);
	}
	return out;
}
