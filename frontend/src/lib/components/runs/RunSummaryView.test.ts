// The Summary's calibration tiles (RunSummaryView.svelte), rendered to HTML with Svelte's server renderer: toned and
// worded as the Calibration panel's own tiles (#586 D12). An NSE no better than the mean flow is flagged with the
// panel's words, and the volume bias reads as the panel writes it ("84.1% too dry"), never a signed PBIAS beside it.
// Synthetic numbers only (the repo is public).
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { CalibrationStats, RunSummary } from '@water-management/engine';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));
import RunSummaryView from './RunSummaryView.svelte';
import CalibrationPanel from '#lib/components/calibration/CalibrationPanel.svelte';
import { metricRows } from '#lib/components/calibration/metrics.js';

const cal = (over: Partial<CalibrationStats> = {}): CalibrationStats => ({
	days: 730,
	nse: 0.72,
	pbias: 3.14,
	rmseM3s: 0.1,
	meanObservedM3s: 1,
	meanSimulatedM3s: 0.97,
	fitStatus: 'fitted',
	...over
});
const summary = (calibration: CalibrationStats): RunSummary =>
	({
		farms: [],
		catchment: { meanNaturalFlowM3Day: 10_000, meanSimulatedOutflowM3Day: 8_000, ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0 },
		calibration,
		warnings: []
	}) as unknown as RunSummary;

/** The tile whose term starts with `term`, as its HTML. */
function tile(html: string, term: string): string {
	const at = html.indexOf(`>${term}<`);
	expect(at, term).toBeGreaterThan(-1);
	const start = html.lastIndexOf('<div class="stat', at);
	expect(start, term).toBeGreaterThan(-1);
	return html.slice(start, html.indexOf('</div>', at));
}

describe('RunSummaryView calibration tiles (#586 D12)', () => {
	it('flags an NSE no better than the mean flow, as the panel does', () => {
		const html = render(RunSummaryView, { props: { summary: summary(cal({ nse: -2.26 })), days: 730 } }).body;
		const nse = tile(html, 'Calibration NSE');
		expect(nse).toContain('flagged');
		expect(nse).toContain('no better than the mean flow');
		// The panel's own NSE tile carries the same mark.
		expect(metricRows(cal({ nse: -2.26 })).find((r) => r.key === 'nse')!.worseThanMean).toBe(true);
		const panel = render(CalibrationPanel, { props: { calibration: cal({ nse: -2.26 }) } }).body;
		expect(panel).toContain('No better than the mean flow.');
	});

	it('leaves a better-than-mean NSE unflagged (positive control)', () => {
		const nse = tile(render(RunSummaryView, { props: { summary: summary(cal()), days: 730 } }).body, 'Calibration NSE');
		expect(nse).not.toContain('flagged');
		expect(nse).not.toContain('no better than the mean flow');
	});

	it('words the volume bias as the panel does, with no signed PBIAS', () => {
		// PBIAS +84.1 (Moriasi: positive = too dry) is the panel's "84.1% too dry".
		const html = render(RunSummaryView, { props: { summary: summary(cal({ pbias: 84.1 })), days: 730 } }).body;
		const bias = tile(html, 'Calibration volume bias');
		expect(bias).toContain('84.1% too dry');
		expect(bias).not.toMatch(/\+84|over-estimates|under-estimates/);
		expect(metricRows(cal({ pbias: 84.1 })).find((r) => r.key === 'pbias')!.value).toBe('84.1% too dry');
		expect(tile(render(RunSummaryView, { props: { summary: summary(cal({ pbias: -1.5 })), days: 730 } }).body, 'Calibration volume bias')).toContain('1.5% too wet');
	});
});
