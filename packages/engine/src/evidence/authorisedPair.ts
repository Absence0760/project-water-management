// The full-allocation pair behind page 1's headline board, as something an
// assessor can re-derive and re-run (issue #523 G2; docs/evidence-pack.md
// § Both impact bases and § Reproduction). The pair isn't stored as runs (no
// run list entry, no run cap: backend evidence/authorisedImpact.ts), so the
// board records what re-deriving it needs and what it must give:
//
//  - how the pair is derived: the baseline run's stored input with
//    settings.allocationMode `fullAllocation`, and the application's recorded
//    ops applied to that (authorisedPairInputs);
//  - both runs' results digests (bundle.ts runResultsDigest), so a re-run that
//    gives the same digests is the same pair, day for day;
//  - how each registered volume was held as at the baseline run (the
//    authorisation frozen with it, backend 226), so the mix is the one the
//    baseline's rows gave, not today's rows.
//
// The record is in the report (and so in the pack's manifest, whose hash the
// verify lookup returns), and bundle.ts's checkPackBundle re-derives the pair
// from the bundle's baseline input and scenario.json, re-runs it, and checks
// the digests, the board and the mix. Pure: the SHA-256 is the caller's.
import type { ModelInput, ModelOutput } from '../project';
import { runModelChecked } from '../run';
import { applyScenario } from '../scenario/overrides';
import type { ScenarioOp } from '../scenario/ops';
import { authorisedMix, type AuthorisedMix, type MixEntry } from './authorised';
import { licenceImpactBoard } from './impact';
import type { EvidenceImpactInput, EvidenceLicenceImpact } from './types';
import { runResultsDigest, type BundleHash } from './bundle';

/** Bumped whenever the record's shape or the pair's derivation changes. */
export const AUTHORISED_PAIR_VERSION = 'pair-1';

/** How one registered volume of the baseline run was held when that run was stored (null: no living row then). */
export interface AuthorisedPairKind {
	allocationId: string;
	authorisation: string | null;
}

/**
 * What re-deriving the headline board needs and must give (the board's
 * `reproduction`, evidence-19). Absent from a board built before; a viewer
 * kept from each registered volume is served the board without it.
 */
export interface AuthorisedPairRecord {
	version: typeof AUTHORISED_PAIR_VERSION;
	/** runResultsText's version the digests are of. */
	resultsVersion: string;
	/** The derivation, said: the baseline's input at this allocation mode, the application's ops on it. */
	allocationMode: 'fullAllocation';
	/** The SHA-256 of the application's recorded ops (scenario.opsSha256), the ops the pair applied. */
	opsSha256: string | null;
	/** Both runs' results digests (bundle.ts runResultsDigest). */
	baselineResultsSha256: string;
	applicationResultsSha256: string;
	/** The outcome settings the board was built with. */
	yearClassMethod: EvidenceImpactInput['yearClassMethod'];
	siteNodeId: string | null;
	/** Each registered volume the pair held a holder to (a take, not s21b storage only), by id, as held at the baseline. */
	kinds: AuthorisedPairKind[];
}

/** The registered volumes a full-allocation run of `input` holds holders to: those that take (not s21b storage only). */
export const authorisedTakes = (input: Pick<ModelInput, 'model'>) => (input.model.allocations ?? []).filter((a) => a.waterUse !== '21b' && a.volumeM3PerYear > 0);

/** The baseline input at full allocation: every holder at their registered volume (the backend strips no more: it is the stored input). */
export const atFullAllocation = (base: ModelInput): ModelInput => ({ ...base, settings: { ...base.settings, allocationMode: 'fullAllocation' } as ModelInput['settings'] });

/**
 * The pair's two inputs, re-derived: the baseline at full allocation, and the
 * application's ops applied to it (unmasked: the backend refuses a board whose
 * masked derivation differs, so this is the pair it ran). `problems` lists the
 * ops that don't apply; a pair with any isn't the board's.
 */
export function authorisedPairInputs(base: ModelInput, ops: readonly ScenarioOp[]): { baseline: ModelInput; application: ModelInput; problems: string[] } {
	const baseline = atFullAllocation(base);
	const { input, problems } = applyScenario(baseline, ops);
	return { baseline, application: input, problems };
}

/** A run's catchment series as stored values (JSON has no NaN): null for a gap. */
export const catchmentSeriesValues = (out: Pick<ModelOutput, 'series'>, key: string): (number | null)[] | null => {
	const s = out.series.find((x) => x.nodeId === null && x.key === key);
	return s ? Array.from(s.values, (v) => (Number.isFinite(v) ? v : null)) : null;
};

/** The headline board over a run pair, as the backend builds it: the baseline names the site. */
export function authorisedPairBoard(
	baselineInput: Pick<ModelInput, 'model'>,
	background: ModelOutput,
	application: ModelOutput,
	o: { yearClassMethod: EvidenceImpactInput['yearClassMethod']; siteNodeId: string | null }
): EvidenceLicenceImpact {
	return licenceImpactBoard(
		{ startDate: background.startDate, summary: background.summary, natural: catchmentSeriesValues(background, 'natural_flow'), ewrShortfall: catchmentSeriesValues(background, 'ewr_shortfall') },
		{ startDate: application.startDate, summary: application.summary, ewrShortfall: catchmentSeriesValues(application, 'ewr_shortfall') },
		{ yearClassMethod: o.yearClassMethod, siteNodeId: o.siteNodeId, nameOf: (id) => baselineInput.model.nodes.find((n) => n.id === id)?.name ?? null }
	);
}

/** A run's results digest, fresh from the engine. */
export const freshResultsDigest = async (out: ModelOutput, hash: BundleHash): Promise<string> =>
	(await runResultsDigest({ startDate: out.startDate, summary: out.summary, series: out.series }, hash)).sha256;

/** The kinds of the takes of `input`, sorted by id, from `kindOf` (the frozen authorisation by allocation id). */
export function pairKinds(input: Pick<ModelInput, 'model'>, kindOf: (allocationId: string) => string | null | undefined): AuthorisedPairKind[] {
	return authorisedTakes(input)
		.map((a) => ({ allocationId: a.id, authorisation: kindOf(a.id) ?? null }))
		.sort((a, b) => (a.allocationId < b.allocationId ? -1 : a.allocationId > b.allocationId ? 1 : 0));
}

/**
 * The full mix again from the baseline input's takes and the recorded kinds
 * (holders don't change the full mix, only the folded one, whose holder keys
 * never leave the server). Null when a take has no recorded kind, or a kind
 * names no take: the record isn't the input's.
 */
export function mixFromRecord(input: Pick<ModelInput, 'model'>, kinds: readonly AuthorisedPairKind[]): AuthorisedMix | null | 'mismatch' {
	const takes = authorisedTakes(input);
	const byId = new Map(kinds.map((k) => [k.allocationId, k.authorisation]));
	if (byId.size !== kinds.length || takes.length !== kinds.length || takes.some((a) => !byId.has(a.id))) return 'mismatch';
	const entries: MixEntry[] = takes.map((a) => ({ volumeM3PerYear: a.volumeM3PerYear, waterUse: a.waterUse ?? null, authorisation: byId.get(a.id) ?? null, waterSource: a.waterSource }));
	return authorisedMix(entries);
}

/** Run both inputs of the pair (runModelChecked throws the engine's own words). */
export function runAuthorisedPair(pair: { baseline: ModelInput; application: ModelInput }): { background: ModelOutput; application: ModelOutput } {
	return { background: runModelChecked(structuredClone(pair.baseline)), application: runModelChecked(structuredClone(pair.application)) };
}

/** Deep equality of plain data, key order ignored, NaN equal to NaN (two derivations of one input). */
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	const arr = (x: object): x is ArrayLike<unknown> => Array.isArray(x) || ArrayBuffer.isView(x);
	if (arr(a) || arr(b)) {
		if (!(arr(a) && arr(b)) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
		return true;
	}
	const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
	const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
	if (ka.length !== kb.length) return false;
	return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Whether two inputs are the same model input (settings, model and every series' days and values). */
export const sameModelInput = (a: ModelInput, b: ModelInput): boolean => same(a.settings, b.settings) && same(a.model, b.model) && same(a.series, b.series);
