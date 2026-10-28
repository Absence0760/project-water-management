// § 3 (Model and data): where the baseline's GR4J parameters came from when
// the regional prior had a part (evidence-22, issue #622, docs/model.md
// §2.10m, docs/evidence-pack.md). Read from the baseline run's settings
// snapshot only, so a pack's document says what that run ran on:
//
//  - the fit record names a prior (the fit used its penalty or its box):
//    "calibrated with the regional prior";
//  - else the catchment's start record (settings.gr4jPrior), when the run's
//    parameters still hold what it wrote and no fit was applied after it:
//    "parameters from the regional prior", the donors' medians, not a fit.
//
// Its own module so a merge with other § 3 changes stays easy.
import { currentPriorStart, type PriorFitResult, type PriorProvenance, type PriorStartRecord } from '../calibrate/prior';
import type { Gr4jParams } from '../runoff/params';

export interface EvidenceRegionalPrior {
	/** 'fit': a fit used the prior; 'start': the parameters are its medians, with no fit since. */
	kind: 'fit' | 'start';
	/** Donors the prior kept, and offered. */
	donors: number;
	donorCount: number;
	dataset: string;
	synthetic: boolean;
	donorSetSha256: string;
	/** The leave-one-out skill (null: none); `noSkill` when it is null or ≤ 0. */
	leaveOneOutSkill: number | null;
	noSkill: boolean;
	/** For 'fit': the penalty weight (0 = off) and whether the search kept to the p10–p90 box; null for 'start'. */
	weight: number | null;
	bounded: boolean | null;
	/** The § 3 line, as printed. */
	text: string;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function line(kind: 'fit' | 'start', p: PriorProvenance, fit: Pick<PriorFitResult, 'weight' | 'bounded'> | null): EvidenceRegionalPrior {
	const skill = p.leaveOneOutSkill;
	const noSkill = skill === null || !(skill > 0);
	const n = p.donors.length;
	const head =
		kind === 'fit'
			? `Parameters calibrated with the regional prior, ${count(n, 'donor')}`
			: `Parameters from the regional prior, ${count(n, 'donor')} (the donors’ medians, not calibrated)`;
	const how =
		kind === 'fit' && fit
			? [fit.weight > 0 ? `penalty weight ${fit.weight}` : null, fit.bounded ? 'search held to its p10–p90 box' : null].filter(Boolean).join(', ')
			: '';
	const set = `donor set “${p.dataset}”${p.synthetic ? ' (invented donors)' : ''}, ${p.donorCount} offered, SHA-256 ${p.donorSetSha256.slice(0, 12)}…`;
	const skillText = skill === null ? 'no leave-one-out score' : `leave-one-out skill ${skill.toFixed(2)}`;
	const text = `${head}${how ? `; ${how}` : ''}. ${set[0]!.toUpperCase()}${set.slice(1)}; ${skillText}${noSkill ? ': the prior has no skill' : ''}.`;
	return {
		kind,
		donors: n,
		donorCount: p.donorCount,
		dataset: p.dataset,
		synthetic: p.synthetic,
		donorSetSha256: p.donorSetSha256,
		leaveOneOutSkill: skill,
		noSkill,
		weight: kind === 'fit' && fit ? fit.weight : null,
		bounded: kind === 'fit' && fit ? fit.bounded : null,
		text
	};
}

/** The § 3 regional-prior line for a run's settings snapshot, or null when the prior had no part in its parameters. */
export function evidenceRegionalPrior(settings: unknown): EvidenceRegionalPrior | null {
	const s = (settings ?? {}) as {
		fitRecord?: { prior?: PriorFitResult; fittedAt?: string; editedParams?: string[] } | null;
		gr4jPrior?: PriorStartRecord[] | null;
		gr4j?: Partial<Gr4jParams> | null;
	};
	const fit = s.fitRecord ?? null;
	// A fit edited by hand since isn't the prior's any more than any other fit is.
	if (fit?.prior?.provenance && !(fit.editedParams?.length)) return line('fit', fit.prior.provenance, fit.prior);
	const start = currentPriorStart(s.gr4jPrior, null, s.gr4j);
	if (!start?.provenance) return null;
	// A fit applied after the start replaced its parameters (and the record would say so above if it used the prior).
	if (fit?.fittedAt && fit.fittedAt > start.appliedAt) return null;
	return line('start', start.provenance, null);
}
