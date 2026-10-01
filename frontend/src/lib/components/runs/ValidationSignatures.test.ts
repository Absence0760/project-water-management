// The validation signatures' display (ValidationSignatures.svelte, engine ≥ 1.55.0, docs/ui.md), rendered
// to HTML with Svelte's server renderer, and its place in the Plausibility checks panel: shown on a run
// that carries signatures, a quiet note when there is no observed record (null), nothing at all on a run
// made before 1.55.0 (undefined). The browser flow is pinned by e2e/tests/plausibility.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { lowFlowFdcSignature, recessionHoldout, type PlausibilityChecks, type RecessionSegment, type ValidationSignatures as Signatures } from '@water-management/engine';
import PlausibilityPanel from './PlausibilityPanel.svelte';

// SvelteKit's runtime modules aren't there under vitest: the panel fetches other runoff models' runs in an
// $effect, which the server renderer never runs, and the help tip only needs the base path.
vi.mock('$lib/api', () => ({ api: {} }));
vi.mock('$app/paths', () => ({ base: '' }));
import ValidationSignatures from './ValidationSignatures.svelte';
import { PROVISIONAL_SIGNATURE_LIMITS } from './signatures';

/** The rendered HTML as text: comments dropped, each tag a space, whitespace collapsed. A scan, not chained regex replaces (CodeQL js/incomplete-multi-character-sanitization). */
const text = (html: string) => {
	let out = '';
	for (let i = 0; i < html.length; ) {
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end < 0 ? html.length : end + 3;
		} else if (html[i] === '<') {
			const end = html.indexOf('>', i);
			out += ' ';
			i = end < 0 ? html.length : end + 1;
		} else out += html[i++];
	}
	return out.replace(/\s+/g, ' ');
};

const q = Array.from({ length: 399 }, (_, i) => i + 1);
const segs: RecessionSegment[] = Array.from({ length: 9 }, (_, i) => [i * 12, i * 12 + 9]);
const rec = Array.from({ length: 108 }, (_, t) => (1 + (Math.floor(t / 12) % 4)) * Math.exp(-0.08 * (t % 12)));
const sig: Signatures = {
	flowKind: 'flow_observed_m3s',
	baseflow: {
		hughesFilter: { kind: 'quickflow', alpha: 0.995, beta: 0.5, passes: 1 },
		eckhardtFilter: { kind: 'eckhardt', a: 0.98, bfiMax: 0.25 },
		days: 399,
		runs: 1,
		hughes: { observed: 0.62, simulated: 0.4, difference: -0.22 },
		eckhardt: { observed: 0.2, simulated: 0.21, difference: 0.01 },
		withinLimit: false
	},
	lowFlowFdc: lowFlowFdcSignature(q, q, new Uint8Array(399)),
	recessionHoldout: recessionHoldout(rec, rec, segs)
};

const checks = (over: Partial<PlausibilityChecks>): PlausibilityChecks => ({ drySeason: null, naturalised: null, rainSource: null, flowDoubleMass: null, lowFlow: null, recession: null, ...over });
const panel = (c: PlausibilityChecks) => text(render(PlausibilityPanel, { props: { checks: c, projectId: 'p', runId: 'r', runoffModel: 'gr4j', runs: [] } }).body);

describe('the validation signatures display', () => {
	it('keeps the provisional limits in one named place, the engine’s numbers', () => {
		expect(PROVISIONAL_SIGNATURE_LIMITS).toEqual({ bfiDiff: 0.15, lowFlowPct: 50, holdoutSkill: 0, holdoutMinSegs: 8 });
	});

	it('shows the scored record, a verdict, one row per signature with its provisional limit, and the hold-out line', () => {
		const body = text(render(ValidationSignatures, { props: { signatures: sig } }).body);
		expect(body).toContain('On the gauge record at the outlet (the record the calibration statistics score), 399 days, against the simulated outflow');
		expect(body).toContain('The limits are provisional, for the hydrologist to confirm.');
		expect(body).toContain('A signature is outside its limit: see the run’s warnings.');
		expect(body).toContain('Provisional limit');
		expect(body).toContain('Base-flow index, Hughes et al. (2003) 0.62 0.40 −0.22 ±0.15 outside');
		expect(body).toContain('Base-flow index, Eckhardt (2005) 0.20 0.21 +0.01 ±0.15 within');
		expect(body).toContain('Low-flow FDC slope, Q70–Q95');
		expect(body).toMatch(/Low-flow volume bias \(%BiasFLV\) – – \+0 % ±50 % within/);
		expect(body).toMatch(/Skill on held-out recessions [\d.]+ 1\.00 – simulated ≥ 0 within/);
		expect(body).toContain('Held-out recessions: every third of 9 rain-free recession segments');
		// The row outside its limit is shaded, the others not.
		const html = render(ValidationSignatures, { props: { signatures: sig } }).body;
		expect(html.match(/class="[^"]*short-row/g)).toHaveLength(1);
	});

	it('says every signature is within its limit when none is outside', () => {
		const ok = { ...sig, baseflow: { ...sig.baseflow!, hughes: { observed: 0.62, simulated: 0.6, difference: -0.02 }, withinLimit: true } };
		const body = text(render(ValidationSignatures, { props: { signatures: ok } }).body);
		expect(body).toContain('Every signature is within its limit.');
		expect(render(ValidationSignatures, { props: { signatures: ok } }).body).not.toMatch(/class="[^"]*short-row/);
	});

	it('is not judged when nothing could be computed, and says so quietly with no observed record', () => {
		const none = { flowKind: 'flow_observed_m3s', baseflow: null, lowFlowFdc: null, recessionHoldout: null } as const;
		expect(text(render(ValidationSignatures, { props: { signatures: none } }).body)).toContain('Not judged: too few scored days or recession segments.');
		const nul = text(render(ValidationSignatures, { props: { signatures: null } }).body);
		expect(nul).toContain('Validation signatures');
		expect(nul).toContain('Not computed: needs an observed flow record.');
		expect(nul).not.toContain('Provisional limit');
	});
});

describe('the validation signatures in the Plausibility checks panel', () => {
	it('six checks and the section on a run from engine 1.55.0', () => {
		const body = panel(checks({ signatures: sig }));
		expect(body).toContain('Six checks a reviewing hydrologist makes by hand');
		expect(body).toContain('Validation signatures: see below');
		expect(body).toContain('Provisional limit');
	});

	it('the quiet note when the run has no observed record (null)', () => {
		const body = panel(checks({ signatures: null }));
		expect(body).toContain('Six checks');
		expect(body).toContain('Not computed: needs an observed flow record.');
	});

	it('nothing on a run made before engine 1.55.0 (undefined): five checks, no section', () => {
		const body = panel(checks({}));
		expect(body).toContain('Five checks a reviewing hydrologist makes by hand');
		expect(body).not.toContain('Validation signatures');
	});
});
