// § 3 (Model and data): where the baseline's GR4J parameters came from when
// the regional prior had a part (evidence-22, issue #622, docs/model.md
// §2.10m, docs/evidence-pack.md). Read from the baseline run's settings
// snapshot only, so a pack's document says what that run ran on:
//
//  - the fit record names a prior (the fit used its penalty or its box):
//    "calibrated with the regional prior";
//  - else the catchment's start record (settings.gr4jPrior) for the target
//    the run's GR4J parameters are now (the catchment, or under calibration
//    zones the site's zone with its units), when they still hold what it
//    wrote and no fit was applied after it:
//    "parameters from the regional prior", the donors' medians, not a fit.
//
// Its own module so a merge with other § 3 changes stays easy.
import { currentPriorStart, type PriorFitResult, type PriorProvenance, type PriorStartRecord, type PriorTargetRef } from '../calibrate/prior';
import { zoneFitPlan } from '../calibrate/stepwise';
import { headlineCalibrationSettings } from '../calibrate/locations';
import { mergeSettings } from '../prepare';
import type { ModelInput } from '../project';
import { editedParams, type FitRecord } from '../calibrate/provenance';
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
	/** The leave-one-out skill (null: not scored, too few donors); `noSkill` when it is ≤ 0 (a null skill is unknown, not none). */
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
	const noSkill = skill !== null && !(skill > 0);
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
	const skillText = skill === null ? 'no leave-one-out score (too few donors), so its skill is unknown' : `leave-one-out skill ${skill.toFixed(2)}`;
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

/**
 * The headline location's target now (engine 1.110.0, issue #659: its key and group under calibration locations,
 * else the catchment, every unit); null when the locations can't be read.
 */
function siteTarget(inputs: { settings?: unknown; model?: unknown }): PriorTargetRef | null {
	if (!inputs.model) return { zoneNodeId: null, units: null };
	try {
		const plan = zoneFitPlan({ settings: inputs.settings, model: inputs.model, series: {} } as unknown as ModelInput);
		const site = plan?.find((p) => p.headline);
		return { zoneNodeId: site ? site.zoneNodeId : null, units: site ? [...site.units].sort() : null };
	} catch {
		return null;
	}
}

/** The snapshot's headline location's settings (fit record, parameters), the top level's for a snapshot without a network. */
function headlineOf(inputs: { settings?: unknown; model?: unknown }): Record<string, unknown> {
	const raw = (inputs.settings ?? {}) as Record<string, unknown>;
	const nodes = (inputs.model as { nodes?: ModelInput['model']['nodes'] } | undefined)?.nodes;
	if (!Array.isArray(nodes)) return raw;
	const hs = headlineCalibrationSettings(mergeSettings(raw as ModelInput['settings'], [], nodes), nodes);
	// At the outlet the top level is the headline's, as stored.
	return hs.calibrationSiteNodeId == null ? raw : { ...raw, fitRecord: hs.fitRecord, gr4j: hs.gr4j };
}

/**
 * The § 3 regional-prior line for a run's input snapshot (its settings and
 * network), or null when the prior had no part in its parameters.
 */
export function evidenceRegionalPrior(inputs: { settings?: unknown; model?: unknown } | null | undefined): EvidenceRegionalPrior | null {
	// The headline location's fit record and parameters (engine 1.110.0, issue #659): a gauge's row, or the top level.
	const s = headlineOf(inputs ?? {}) as {
		fitRecord?: (Partial<FitRecord> & { prior?: PriorFitResult }) | null;
		gr4jPrior?: PriorStartRecord[] | null;
		gr4j?: Partial<Gr4jParams> | null;
	};
	const fit = s.fitRecord ?? null;
	// A fit edited by hand since isn't the prior's any more than any other fit is: recomputed from the snapshot's parameters.
	if (fit?.prior?.provenance && Array.isArray(fit.free) && fit.params && fit.model) {
		const edited = editedParams(s as never, { model: fit.model, free: fit.free, params: fit.params });
		if (!edited.length) return line('fit', fit.prior.provenance, fit.prior);
	}
	// The catchment's start record, for the target the run's GR4J parameters (settings.gr4j) are now: the catchment, or
	// under calibration zones the site's own zone with the units it has now.
	const target = siteTarget(inputs ?? {});
	const start = target ? currentPriorStart(s.gr4jPrior, target, s.gr4j) : null;
	if (!start?.provenance) return null;
	// A fit applied after the start replaced its parameters (and the record would say so above if it used the prior).
	if (fit?.fittedAt && Date.parse(fit.fittedAt) > Date.parse(start.appliedAt)) return null;
	return line('start', start.provenance, null);
}
