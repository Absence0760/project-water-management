// Display helpers for the validation signatures (RunSummary.plausibility.
// signatures, engine ≥ 1.55.0; docs/model.md §2.10d "Validation signatures",
// docs/ui.md). Pure, unit-tested.
import { BFI_WARN_DIFF, FDC_LOW_WARN_PCT, HOLDOUT_SKILL_WARN, RECESSION_MIN_SEGMENTS, type ValidationSignatures } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

const RECORD: Record<string, string> = { flow_observed_m3s: 'gauge', flow_logger_m3s: 'logger' };

/**
 * PROVISIONAL warning limits of the validation signatures, pending the
 * hydrologist: see docs/followups.md § Hydrologist (CR-16's thresholds).
 * The engine owns the numbers (packages/engine/src/plausibility/signatures.ts),
 * since its run warnings and each signature's withinLimit / agrees use them;
 * this names them in one place for the display, which marks them provisional,
 * so a change there reaches the table without a second copy here.
 *   bfiDiff        0.15  |simulated − observed| base-flow index, by either filter
 *   lowFlowPct     50    |bias| %, of the Q70–Q95 slope and of %BiasFLV
 *   holdoutSkill   0     the simulated skill on held-out recessions is at least this
 *   holdoutMinSegs 8     fewer recession segments: not judged
 */
export const PROVISIONAL_SIGNATURE_LIMITS = {
	bfiDiff: BFI_WARN_DIFF,
	lowFlowPct: FDC_LOW_WARN_PCT,
	holdoutSkill: HOLDOUT_SKILL_WARN,
	holdoutMinSegs: RECESSION_MIN_SEGMENTS
} as const;
const L = PROVISIONAL_SIGNATURE_LIMITS;

/** Every computed signature within its limit: true; one outside: false; none judged: null. */
export function signaturesOk(s: ValidationSignatures | null | undefined): boolean | null {
	if (!s) return null;
	const oks = [s.baseflow?.withinLimit ?? null, s.lowFlowFdc?.withinLimit ?? null, s.recessionHoldout?.agrees ?? null];
	return oks.includes(false) ? false : oks.some((o) => o === true) ? true : null;
}

/** "the gauge record" or "the logger record at gauge “Weir”". */
export function scoredRecordText(s: Pick<ValidationSignatures, 'flowKind' | 'siteName'>): string {
	const rec = `the ${RECORD[s.flowKind] ?? 'observed'} record`;
	return s.siteName ? `${rec} at gauge “${s.siteName}”` : `${rec} at the outlet`;
}

export interface SignatureRow {
	label: string;
	observed: string;
	simulated: string;
	/** Simulated − observed, or the bias in %. */
	difference: string;
	/** The limit in words. */
	limit: string;
	/** Within the limit; null = not computed. */
	ok: boolean | null;
}

/** A value with a true minus sign, "−0.20" (fmtNum writes a hyphen), as the Compare page prints it. */
const minus = (v: number, digits: number) => (v < 0 && Number(Math.abs(v).toFixed(digits)) !== 0 ? '−' : '') + fmtNum(Math.abs(v), digits);
const signed = (v: number, digits: number, unit = '') => `${v < 0 && Number(Math.abs(v).toFixed(digits)) !== 0 ? '−' : '+'}${fmtNum(Math.abs(v), digits)}${unit}`;
const inLimit = (v: number | null, limit: number) => (v === null ? null : Math.abs(v) <= limit);

/** The table rows: BFI by each filter, the low-flow FDC's slope and volume bias, the held-out recessions. */
export function signatureRows(s: ValidationSignatures): SignatureRow[] {
	const rows: SignatureRow[] = [];
	const bf = s.baseflow;
	for (const [label, p] of [
		['Base-flow index, Hughes et al. (2003)', bf?.hughes ?? null],
		['Base-flow index, Eckhardt (2005)', bf?.eckhardt ?? null]
	] as const) {
		rows.push(
			p
				? { label, observed: fmtNum(p.observed, 2), simulated: fmtNum(p.simulated, 2), difference: signed(p.difference, 2), limit: `±${fmtNum(L.bfiDiff, 2)}`, ok: inLimit(p.difference, L.bfiDiff) }
				: { label, observed: '–', simulated: '–', difference: '–', limit: `±${fmtNum(L.bfiDiff, 2)}`, ok: null }
		);
	}
	const f = s.lowFlowFdc;
	const range = f ? `Q${f.range[0]}–Q${f.range[1]}` : 'Q70–Q95';
	rows.push({
		label: `Low-flow FDC slope, ${range}`,
		observed: f ? fmtNum(f.observedSlope, 2) : '–',
		simulated: f ? fmtNum(f.simulatedSlope, 2) : '–',
		difference: f && f.slopeBiasPct !== null ? signed(f.slopeBiasPct, 0, ' %') : '–',
		limit: `±${L.lowFlowPct} %`,
		ok: f ? inLimit(f.slopeBiasPct, L.lowFlowPct) : null
	});
	rows.push({
		label: 'Low-flow volume bias (%BiasFLV)',
		observed: '–',
		simulated: '–',
		difference: f && f.lowVolumeBiasPct !== null ? signed(f.lowVolumeBiasPct, 0, ' %') : '–',
		limit: `±${L.lowFlowPct} %`,
		ok: f ? inLimit(f.lowVolumeBiasPct, L.lowFlowPct) : null
	});
	const h = s.recessionHoldout;
	rows.push({
		label: 'Skill on held-out recessions',
		observed: h && h.lawSkill !== null ? minus(h.lawSkill, 2) : '–',
		simulated: h && h.modelSkill !== null ? minus(h.modelSkill, 2) : '–',
		difference: '–',
		limit: `simulated ≥ ${fmtNum(L.holdoutSkill, 0)}`,
		ok: h ? h.agrees : null
	});
	return rows;
}

/** One line on what the held-out recession test used. */
export function holdoutText(s: ValidationSignatures): string {
	const h = s.recessionHoldout;
	if (!h) return 'Held-out recessions: not computed, since there is no catchment rain to find rain-free recessions with.';
	if (!h.heldOut.length) return `Held-out recessions: ${fmtNum(h.segments)} recession segment${h.segments === 1 ? '' : 's'}, too few to hold one out.`;
	const judged = h.segments >= L.holdoutMinSegs ? '' : ` Not judged: fewer than ${L.holdoutMinSegs} segments.`;
	const dry = h.modelSegments < h.heldOut.length ? ` The simulated flow reaches zero on ${fmtNum(h.heldOut.length - h.modelSegments)} of them, which are left out of its score.` : '';
	return `Held-out recessions: every ${h.every === 3 ? 'third' : `${h.every}th`} of ${fmtNum(h.segments)} rain-free recession segments (${fmtNum(h.heldOut.length)}, ${fmtNum(h.days)} days) held out. The observed column is the river’s own recession curve fitted on the other segments.${dry}${judged}`;
}
