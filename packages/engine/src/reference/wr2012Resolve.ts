// Stored WR2012 settings as a run uses them: merged over the defaults, with an
// unusable reference or threshold dropped and a warning. Only a run needs this
// (../prepare.ts), so it sits apart from the settings module the Settings form
// and every catchment page load (./wr2012Settings.ts, issue #9).
import {
	defaultWr2012Settings,
	WR2012_SCALINGS,
	wr2012FlagIssues,
	wr2012PenaltyIssues,
	wr2012ReferenceIssues,
	type Wr2012Flags,
	type Wr2012Reference,
	type Wr2012Scaling,
	type Wr2012Settings
} from './wr2012Settings';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stored WR2012 settings merged over the defaults; an unusable reference or bad thresholds are dropped with a warning. */
export function resolveWr2012(raw: unknown, warnings: string[]): Wr2012Settings {
	const d = defaultWr2012Settings();
	if (!isObj(raw)) return d;
	const s: Wr2012Settings = {
		reference: isObj(raw.reference) ? (raw.reference as unknown as Wr2012Reference) : null,
		scaling: (WR2012_SCALINGS as readonly unknown[]).includes(raw.scaling) ? (raw.scaling as Wr2012Scaling) : d.scaling,
		lowFlowMonths: Array.isArray(raw.lowFlowMonths)
			? [...new Set(raw.lowFlowMonths.filter((m): m is number => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b)
			: null,
		flags: { ...d.flags, ...(isObj(raw.flags) ? (raw.flags as Partial<Wr2012Flags>) : {}) },
		calibrationPenalty: { ...d.calibrationPenalty, ...(isObj(raw.calibrationPenalty) ? (raw.calibrationPenalty as object) : {}) }
	};
	if (s.lowFlowMonths?.length === 0) s.lowFlowMonths = null;
	if (s.reference) {
		const ref = { ...s.reference, mapMm: s.reference.mapMm ?? null } as Wr2012Reference;
		const issues = wr2012ReferenceIssues(ref);
		if (issues.length) {
			warnings.push(`WR2012 check skipped: the reference data isn't usable (${issues.map((i) => i.message).join(' ')})`);
			s.reference = null;
		} else s.reference = ref;
	}
	const flagIssues = wr2012FlagIssues(s.flags);
	if (flagIssues.length) {
		warnings.push(`WR2012 deviation thresholds aren't usable (${flagIssues.map((i) => i.message).join(' ')}); using the defaults`);
		s.flags = d.flags;
	}
	const penaltyIssues = wr2012PenaltyIssues(s.calibrationPenalty);
	if (penaltyIssues.length) {
		const bad = new Set(penaltyIssues.map((i) => i.field));
		warnings.push(`WR2012 calibration penalty settings aren't usable (${penaltyIssues.map((i) => i.message).join(' ')}); using the default instead`);
		if (bad.has('weight')) s.calibrationPenalty = { ...s.calibrationPenalty, weight: d.calibrationPenalty.weight };
		if (bad.has('marLowMm3') || bad.has('marHighMm3')) s.calibrationPenalty = { ...s.calibrationPenalty, marLowMm3: null, marHighMm3: null };
	}
	s.calibrationPenalty.enabled = s.calibrationPenalty.enabled === true;
	return s;
}
