// The validation signatures' display helpers (engine ≥ 1.55.0, docs/model.md §2.10d, docs/ui.md).
import { lowFlowFdcSignature, recessionHoldout, type RecessionSegment, type ValidationSignatures } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { holdoutText, scoredRecordText, signatureRows, signaturesOk } from './signatures';

const base: ValidationSignatures = { flowKind: 'flow_observed_m3s', baseflow: null, lowFlowFdc: null, recessionHoldout: null };
const q = Array.from({ length: 399 }, (_, i) => i + 1);
const segs: RecessionSegment[] = Array.from({ length: 9 }, (_, i) => [i * 12, i * 12 + 9]);
const rec = Array.from({ length: 108 }, (_, t) => (1 + (Math.floor(t / 12) % 4)) * Math.exp(-0.08 * (t % 12)));

const sig: ValidationSignatures = {
	...base,
	siteNodeId: 'H',
	siteName: 'Weir',
	baseflow: {
		hughesFilter: { kind: 'quickflow', alpha: 0.995, beta: 0.5, passes: 1 },
		eckhardtFilter: { kind: 'eckhardt', a: 0.98, bfiMax: 0.25 },
		days: 399,
		runs: 1,
		hughes: { observed: 0.62, simulated: 0.4, difference: -0.22 },
		eckhardt: { observed: 0.2, simulated: 0.21, difference: 0.01 },
		withinLimit: false
	},
	lowFlowFdc: lowFlowFdcSignature(q, q.map((v) => v ** 0.4), new Uint8Array(399)),
	recessionHoldout: recessionHoldout(rec, rec, segs)
};

describe('validation signatures display', () => {
	it('names the scored record: the outlet’s or the calibration site’s', () => {
		expect(scoredRecordText(base)).toBe('the gauge record at the outlet');
		expect(scoredRecordText({ flowKind: 'flow_logger_m3s', siteName: 'Weir' })).toBe('the logger record at gauge “Weir”');
	});

	it('one row per signature, with its limit and verdict', () => {
		const rows = signatureRows(sig);
		expect(rows.map((r) => r.label)).toEqual([
			'Base-flow index, Hughes et al. (2003)',
			'Base-flow index, Eckhardt (2005)',
			'Low-flow FDC slope, Q70–Q95',
			'Low-flow volume bias (%BiasFLV)',
			'Skill on held-out recessions'
		]);
		expect(rows[0]).toEqual({ label: rows[0]!.label, observed: '0.62', simulated: '0.40', difference: '−0.22', limit: '±0.15', ok: false });
		expect(rows[1]!.ok).toBe(true);
		expect(rows[2]!.difference).toBe('−60 %');
		expect(rows[2]!.ok).toBe(false);
		expect(rows[4]!.simulated).toBe('1.00');
		expect(rows[4]!.ok).toBe(true);
		expect(signaturesOk(sig)).toBe(false);
	});

	it('not judged when nothing is computed', () => {
		expect(signaturesOk(null)).toBeNull();
		expect(signaturesOk(base)).toBeNull();
		expect(signatureRows(base).every((r) => r.ok === null && r.simulated === '–')).toBe(true);
		expect(holdoutText(base)).toMatch(/no catchment rain/);
	});

	it('says how the recessions were held out', () => {
		expect(holdoutText(sig)).toBe(
			'Held-out recessions: every third of 9 rain-free recession segments (3, 27 days) held out. The observed column is the river’s own recession curve fitted on the other segments.'
		);
		const few = { ...sig, recessionHoldout: recessionHoldout(rec, rec, segs.slice(0, 5)) };
		expect(holdoutText(few)).toMatch(/Not judged: fewer than 8 segments\.$/);
	});
});
