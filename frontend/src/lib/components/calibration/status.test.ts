import { describe, expect, it } from 'vitest';
import { gr4jChanges, statusLine } from './status';

describe('gr4jChanges: the form’s GR4J parameters against the shown run’s', () => {
	it('lists each parameter that differs, the run’s value then the form’s, with its unit', () => {
		expect(gr4jChanges({ x1: 350, x2: 0, x3: 90, x4: 1.7 }, { x1: 321, x2: 0, x3: 90, x4: 1.85 })).toEqual(['X1 350 → 321 mm', 'X4 1.7 → 1.85 days']);
	});

	it('compares to the three decimals the fields show, so a fit’s ninth decimal is no change', () => {
		expect(gr4jChanges({ x1: 426.0810500977728 }, { x1: 426.081 })).toEqual([]);
		expect(gr4jChanges({ x1: 426.0810500977728 }, { x1: 426.09 })).toEqual(['X1 426.081 → 426.09 mm']);
	});

	it('reads a missing X2 as 0 (off), and says nothing when the run kept no parameters', () => {
		expect(gr4jChanges({ x1: 350, x3: 90, x4: 1.7 }, { x1: 350, x2: 0, x3: 90, x4: 1.7 })).toEqual([]);
		expect(gr4jChanges({ x1: 350, x3: 90, x4: 1.7 }, { x1: 350, x2: -0.5, x3: 90, x4: 1.7 })).toEqual(['X2 0 → −0.5 mm/day']);
		expect(gr4jChanges(null, { x1: 1 })).toEqual([]);
	});
});

describe('statusLine: the Calibration page’s first line', () => {
	const scored = { days: 120, nse: -2.26, kge: -0.33, pbias: 84.1 };

	it('a scored run: its name, the NSE (flagged when no better than the mean flow), KGE and the volume bias, and a link to the scores', () => {
		const line = statusLine({ kind: 'run', label: 'Baseline', calibration: scored }, true, true);
		expect(line).toEqual({
			lead: 'Shown run, Baseline:',
			text: 'NSE −2.26, no better than the mean flow · KGE −0.33 · volume bias 84.1% too dry.',
			link: { href: '#res-calibration', label: 'All the scores' },
			tone: 'warn'
		});
		const good = statusLine({ kind: 'run', label: 'Fitted', calibration: { days: 400, nse: 0.71, kge: 0.8, pbias: -3.2 } }, true, true);
		expect(good.text).toBe('NSE 0.71 · KGE 0.80 · volume bias 3.2% too wet.');
		expect(good.tone).toBe('none');
	});

	it('a run with no scores says why, by whether the project has a record', () => {
		expect(statusLine({ kind: 'run', label: 'Rain only', calibration: null }, false, true)).toMatchObject({
			text: 'not scored, the project has no observed flow record.',
			link: { href: '?tab=series', label: 'Add one on Data' }
		});
		expect(statusLine({ kind: 'run', label: 'Narrow', calibration: { days: 0 } }, true, true)).toMatchObject({
			text: 'not scored, no observed flow inside the calibration window.',
			link: { href: '#res-calibration', label: 'Why' }
		});
	});

	it('adds that the form’s parameters differ from the run’s, worded for who can run the model', () => {
		expect(statusLine({ kind: 'run', label: 'Baseline', calibration: scored }, true, true, ['X1 350 → 321 mm']).text).toMatch(/ The form’s GR4J parameters differ from this run’s: run the model to score them\.$/);
		expect(statusLine({ kind: 'run', label: 'Baseline', calibration: scored }, true, false, ['X1 350 → 321 mm']).text).toMatch(/: an editor can run the model to score them\.$/);
	});

	it('no run: what to do first, a record on Data before a run', () => {
		expect(statusLine({ kind: 'none' }, false, true)).toMatchObject({ lead: 'No observed flow record yet.', link: { href: '?tab=series', label: 'add one on Data' } });
		expect(statusLine({ kind: 'none' }, true, true)).toMatchObject({ lead: 'No run yet.', text: 'Run the model to see how its flows fit the observed record.', link: null });
		expect(statusLine({ kind: 'none' }, true, false).text).toBe('An editor can run the model.');
	});

	it('loading keeps the line’s place; a failed list points at the part’s Try again', () => {
		expect(statusLine({ kind: 'loading' }, null, true)).toMatchObject({ lead: 'Loading the shown run…', busy: true });
		expect(statusLine({ kind: 'error' }, null, true).link).toEqual({ href: '#cal-fit', label: 'Try again under How the shown run fits' });
	});
});
