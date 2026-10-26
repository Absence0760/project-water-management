// The Calibration page's answer on its first screen (issue #586 R4-A): one line under the header saying how the shown
// run fits (its scores, toned as the Summary's model checks tone them), or why there is nothing to read yet, with a
// link to where the reader goes next. The page is long (the settings panels, then Model quality), so without it the
// scores sat ~3,800 px down at 1440 × 960 and ~6,000 px on a phone, and a project with no flow record said so only
// at the page's foot. Also: which GR4J parameters in the form differ from the ones the shown run used, so a reader
// who has just edited them doesn't read the old run's fit as theirs. Pure, so both are unit-tested without the page.
import { GR4J_PARAMS } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { volumeBiasText, worseThanMean, WORSE_THAN_MEAN } from './metrics';

type Gr4j = Partial<Record<'x1' | 'x2' | 'x3' | 'x4', number | null>>;

/** Short names for the change list: the form's labels end in the parameter's symbol ("Production store capacity X1"). */
const SYMBOL: Record<string, string> = { x1: 'X1', x2: 'X2', x3: 'X3', x4: 'X4' };

/**
 * The GR4J parameters the form has that the run didn't use, each "X1 350 → 321 mm" (the run's value, then the
 * form's, at most three decimals as the fields show them). Empty when they match to those decimals, or when the run kept no GR4J
 * parameters to compare with (an older or legacy run): it then says nothing rather than guess.
 */
export function gr4jChanges(run: Gr4j | null | undefined, form: Gr4j | null | undefined): string[] {
	if (!run || !form) return [];
	const out: string[] = [];
	for (const p of GR4J_PARAMS) {
		const was = run[p.key] ?? (p.key === 'x2' ? 0 : null);
		const now = form[p.key] ?? (p.key === 'x2' ? 0 : null);
		if (was == null || now == null || !Number.isFinite(was) || !Number.isFinite(now)) continue;
		// Compared as the fields show them (three decimals): a fit's ninth decimal isn't a change anyone could read as
		// "426.081 → 426.081", and doesn't move the fit.
		if (Math.round(was * 1000) === Math.round(now * 1000)) continue;
		out.push(`${SYMBOL[p.key]} ${fmtNum(was, 3, true)} → ${fmtNum(now, 3, true)} ${p.unit}`);
	}
	return out;
}

/** What the page knows about How the shown run fits, as CalibrationResults reports it. */
export type CalState =
	| { kind: 'loading' }
	| { kind: 'error' }
	| { kind: 'none' }
	| {
			kind: 'run';
			label: string;
			calibration: { days: number; nse?: number | null; kge?: number | null; pbias?: number | null } | null | undefined;
	  };

export interface StatusLine {
	/** The line's bold start: the run it is about, or the state. */
	lead: string;
	text: string;
	/** Where the reader goes next, if anywhere. */
	link: { href: string; label: string } | null;
	/** 'warn' when the fit is no better than the mean flow (the NSE tile's tone and words, #586 D12). */
	tone: 'warn' | 'none';
	/** Still loading: the line keeps its place so the panels under it don't jump. */
	busy?: true;
}

/**
 * The page's first line. `hasRecord`: the project has an observed or logger flow record (null while not known).
 * `canEdit`: the reader can run the model. `changed`: gr4jChanges for the shown run, added as a note.
 */
export function statusLine(state: CalState, hasRecord: boolean | null, canEdit: boolean, changed: readonly string[] = []): StatusLine {
	if (state.kind === 'loading') return { lead: 'Loading the shown run…', text: '', link: null, tone: 'none', busy: true };
	if (state.kind === 'error') return { lead: 'The runs couldn’t be loaded.', text: '', link: { href: '#cal-fit', label: 'Try again under How the shown run fits' }, tone: 'none' };
	if (state.kind === 'none') {
		if (hasRecord === false)
			return { lead: 'No observed flow record yet.', text: 'A fit needs a flow record measured at a gauge:', link: { href: '?tab=series', label: 'add one on Data' }, tone: 'none' };
		return { lead: 'No run yet.', text: canEdit ? 'Run the model to see how its flows fit the observed record.' : 'An editor can run the model.', link: null, tone: 'none' };
	}
	const after = changed.length ? ` The form’s GR4J parameters differ from this run’s: ${canEdit ? 'run the model' : 'an editor can run the model'} to score them.` : '';
	const cal = state.calibration;
	const lead = `Shown run, ${state.label}:`;
	if (!cal || cal.days === 0) {
		// No record at all: the fix is on Data. Otherwise the panel says why (the window, the exclusions) and links its fixes.
		if (hasRecord === false) return { lead, text: `not scored, the project has no observed flow record.${after}`, link: { href: '?tab=series', label: 'Add one on Data' }, tone: 'none' };
		return { lead, text: `not scored, no observed flow inside the calibration window.${after}`, link: { href: '#res-calibration', label: 'Why' }, tone: 'none' };
	}
	const poor = worseThanMean('nse', cal.nse);
	const bias = volumeBiasText(cal.pbias == null ? null : -cal.pbias);
	const parts = [`NSE ${fmtNum(cal.nse, 2)}${poor ? `, ${WORSE_THAN_MEAN}` : ''}`, cal.kge == null ? null : `KGE ${fmtNum(cal.kge, 2)}`, bias === '–' ? null : `volume bias ${bias}`];
	return { lead, text: `${parts.filter(Boolean).join(' · ')}.${after}`, link: { href: '#res-calibration', label: 'All the scores' }, tone: poor ? 'warn' : 'none' };
}
