// Hysteresis (WP-2.13): a rule fires once on crossing, stays quiet while the
// value hovers at the line, and re-arms only after recovering past the margin.
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, DAM_MARGIN, defaultMode, fires, recovered, step, THRESHOLD, type AlertKind } from './rules.js';

/** Run a value series through step(), returning each step and how many events opened. */
function simulate(kind: AlertKind, threshold: number, values: (number | null)[]) {
	let firing = false;
	let opened = 0;
	const steps = values.map((v) => {
		const s = step(firing, kind, threshold, v);
		if (s === 'open') {
			firing = true;
			opened++;
		} else if (s === 'clear') firing = false;
		return s;
	});
	return { steps, opened, firing };
}

describe('dam_below hysteresis', () => {
	it('fires once on crossing below the threshold', () => {
		expect(simulate('dam_below', 0.3, [0.5, 0.4, 0.29, 0.2]).steps).toEqual(['keep', 'keep', 'open', 'keep']);
	});

	it('sends one alert for a dam hovering at the threshold, not one a day', () => {
		const hover = [0.31, 0.29, 0.31, 0.29, 0.32, 0.28, 0.34, 0.29];
		const r = simulate('dam_below', 0.3, hover);
		expect(r.opened).toBe(1);
		expect(r.steps.filter((s) => s === 'clear')).toEqual([]);
	});

	it('re-arms only after recovering to threshold + 5 points, then fires again on the next crossing', () => {
		const r = simulate('dam_below', 0.3, [0.2, 0.34, 0.349, 0.35, 0.36, 0.29]);
		expect(r.steps).toEqual(['open', 'keep', 'keep', 'clear', 'keep', 'open']);
		expect(r.opened).toBe(2);
		expect(recovered('dam_below', 0.3, 0.3 + DAM_MARGIN)).toBe(true);
	});

	it('clears when the figure is gone (the farm left the publication), and does nothing on none while quiet', () => {
		expect(simulate('dam_below', 0.3, [0.2, null]).steps).toEqual(['open', 'clear']);
		expect(simulate('dam_below', 0.3, [null, Number.NaN]).steps).toEqual(['keep', 'keep']);
	});
});

describe('the other kinds', () => {
	it('ewr_forecast_fail fires at N days and re-arms at N − 2 or fewer (never below 0)', () => {
		expect(simulate('ewr_forecast_fail', 3, [0, 3, 2, 3, 1, 4]).steps).toEqual(['keep', 'open', 'keep', 'keep', 'clear', 'open']);
		expect(recovered('ewr_forecast_fail', 1, 0)).toBe(true);
		expect(recovered('ewr_forecast_fail', 1, 1)).toBe(false);
	});

	it('data_stale fires past its threshold of late days and re-arms once under it', () => {
		expect(simulate('data_stale', 3, [-5, 3, 4, 3, 2, 5]).steps).toEqual(['keep', 'keep', 'open', 'keep', 'clear', 'open']);
	});

	it('feed_failing and job_dead fire at N and re-arm only at 0', () => {
		expect(simulate('feed_failing', 3, [1, 3, 5, 1, 0, 3]).steps).toEqual(['keep', 'open', 'keep', 'keep', 'clear', 'open']);
		expect(simulate('job_dead', 1, [0, 1, 2, 0]).steps).toEqual(['keep', 'open', 'keep', 'clear']);
	});

	it('farms_short fires at N farms short and re-arms only when none is (issue #120)', () => {
		expect(simulate('farms_short', 2, [0, 1, 2, 3, 1, 0, 2]).steps).toEqual(['keep', 'keep', 'open', 'keep', 'keep', 'clear', 'open']);
		// A person's publication has no value: a firing alert clears, a quiet one stays quiet.
		expect(simulate('farms_short', 1, [3, null, null]).steps).toEqual(['open', 'clear', 'keep']);
	});

	it('restriction_published never fires on a value (each notice change is its own event)', () => {
		expect(fires('restriction_published', 0, 100)).toBe(false);
	});
});

describe('thresholds', () => {
	it('accepts each kind’s range and refuses the rest (the 051 CHECK)', () => {
		expect(THRESHOLD.dam_below.safeParse(0.3).success).toBe(true);
		expect(THRESHOLD.dam_below.safeParse(30).success).toBe(false);
		expect(THRESHOLD.dam_below.safeParse(0).success).toBe(false);
		expect(THRESHOLD.ewr_forecast_fail.safeParse(2.5).success).toBe(false);
		expect(THRESHOLD.data_stale.safeParse(61).success).toBe(false);
		expect(THRESHOLD.restriction_published.safeParse(0).success).toBe(true);
		expect(THRESHOLD.restriction_published.safeParse(1).success).toBe(false);
		expect(THRESHOLD.farms_short.safeParse(1).success).toBe(true);
		expect(THRESHOLD.farms_short.safeParse(0).success).toBe(false);
		expect(THRESHOLD.farms_short.safeParse(1.5).success).toBe(false);
	});
});

describe('defaultMode (mirrors 051 alert_audience; alerts.db.test.ts checks the database side)', () => {
	it('gives an applicant nothing, a farmer dam and notice alerts only, and viewers opt-in kinds', () => {
		for (const k of ALERT_KINDS) expect(defaultMode('contributor', k)).toBeNull();
		expect(ALERT_KINDS.filter((k) => defaultMode('farmer', k) !== null)).toEqual(['dam_below', 'restriction_published']);
		expect(defaultMode('viewer', 'dam_below')).toBe('off');
		expect(defaultMode('viewer', 'ewr_forecast_fail')).toBe('off');
		expect(defaultMode('viewer', 'data_stale')).toBeNull();
		expect(defaultMode('editor', 'job_dead')).toBe('off');
		expect(defaultMode('owner', 'job_dead')).toBe('immediate');
		// farms_short (issue #120): the WUA's staff; a viewer may opt in; a farmer never (neighbours' shortfalls).
		expect(defaultMode('editor', 'farms_short')).toBe('immediate');
		expect(defaultMode('owner', 'farms_short')).toBe('immediate');
		expect(defaultMode('viewer', 'farms_short')).toBe('off');
		expect(defaultMode('farmer', 'farms_short')).toBeNull();
	});
});
