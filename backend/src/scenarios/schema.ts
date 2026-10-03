// Request bodies for the scenario routes (docs/api.md § Scenarios). The ops
// themselves are checked by the engine's validateScenarioOps, the one
// definition of what an op may hold (packages/engine/src/scenario/ops.ts);
// this wraps it in zod and tightens every id to a UUID, because the rows a
// scenario run writes (run_series.node_id) are uuid columns.
import { createHash } from 'node:crypto';
import { APPLICANT_PROMPT_MAX, canonicalJson, validateScenarioOps, type ScenarioOp } from '@water-management/engine';
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where each op keeps an id, as paths into the op (`transfer.set`'s `value` is an id only when it sets a transfer end or the unit its seepage rejoins below). */
export function opIds(op: ScenarioOp): [string, unknown][] {
	switch (op.op) {
		case 'node.set':
		case 'node.remove':
			return [['nodeId', op.nodeId]];
		case 'node.add':
			return [
				['node.id', op.node.id],
				['node.downstreamNodeId', op.node.downstreamNodeId]
			];
		case 'node.move':
			return [
				['nodeId', op.nodeId],
				['downstreamNodeId', op.downstreamNodeId]
			];
		case 'node.insert':
			return [['node.id', op.node.id], ['node.downstreamNodeId', op.node.downstreamNodeId], ...op.upstreamNodeIds.map((id, i) => [`upstreamNodeIds[${i}]`, id] as [string, unknown])];
		case 'cropArea.set':
			return [
				['nodeId', op.nodeId],
				['cropId', op.cropId]
			];
		case 'crop.add':
			return [['crop.id', op.crop.id]];
		case 'crop.set':
		case 'crop.remove':
			return [['cropId', op.cropId]];
		case 'transfer.add':
			return [
				['transfer.id', op.transfer.id],
				['transfer.fromNodeId', op.transfer.fromNodeId],
				['transfer.toNodeId', op.transfer.toNodeId],
				// The unit an off-take's seepage rejoins below (engine ≥ 1.42.0), when named.
				...(op.transfer.lossReturnNodeId ? ([['transfer.lossReturnNodeId', op.transfer.lossReturnNodeId]] as [string, unknown][]) : [])
			];
		case 'transfer.set':
			return [['transferId', op.transferId], ...(op.field === 'fromNodeId' || op.field === 'toNodeId' || (op.field === 'lossReturnNodeId' && op.value !== null) ? ([['value', op.value]] as [string, unknown][]) : [])];
		case 'transfer.remove':
			return [['transferId', op.transferId]];
		case 'landCover.add':
			return [
				['patch.id', op.patch.id],
				['patch.nodeId', op.patch.nodeId]
			];
		case 'landCover.remove':
		case 'landCover.set':
			return [['patchId', op.patchId]];
		case 'borehole.add':
			return [
				['borehole.id', op.borehole.id],
				['borehole.nodeId', op.borehole.nodeId]
			];
		case 'borehole.remove':
			return [['boreholeId', op.boreholeId]];
		case 'demandObject.add':
			return [
				['demandObject.id', op.demandObject.id],
				['demandObject.nodeId', op.demandObject.nodeId]
			];
		case 'demandObject.set':
		case 'demandObject.remove':
			return [['demandObjectId', op.demandObjectId]];
		case 'demand.scale':
			return (op.nodeIds ?? []).map((id, i) => [`nodeIds[${i}]`, id] as [string, unknown]);
		case 'ewrRule.set':
			// null = the outlet: no id to check.
			return op.table.siteNodeId === null ? [] : [['table.siteNodeId', op.table.siteNodeId]];
		case 'ewrRule.remove':
			return op.siteNodeId === null ? [] : [['siteNodeId', op.siteNodeId]];
		case 'allocation.set':
			return [
				['allocation.id', op.allocation.id],
				['allocation.nodeId', op.allocation.nodeId]
			];
		case 'allocation.remove':
			return [['allocationId', op.allocationId]];
		case 'settings.set':
		case 'series.scale':
			return [];
	}
}

/**
 * validateScenarioOps plus UUID ids. `errors` name each problem by path
 * (`ops[3].nodeId: must be a UUID`); the ops are rebuilt from their known
 * fields only, so unknown keys never reach the database. `stored`: the ops
 * the list replaces, whose names from before issue #385 it may keep.
 */
export function checkOps(raw: unknown, stored?: readonly ScenarioOp[]): { ops: ScenarioOp[]; errors: string[] } {
	const { ops, errors } = validateScenarioOps(raw, { stored });
	if (errors.length) return { ops, errors };
	ops.forEach((op, i) => {
		for (const [path, v] of opIds(op)) if (typeof v !== 'string' || !UUID_RE.test(v)) errors.push(`ops[${i}].${path}: must be a UUID`);
	});
	return { ops, errors };
}

/** zod wrapper: the checked ops, or one issue per error. `stored`: the ops they replace (checkOps). */
export const opsReplacing = (stored?: readonly ScenarioOp[]) =>
	z.unknown().transform((raw, ctx) => {
		const { ops, errors } = checkOps(raw, stored);
		for (const message of errors) ctx.addIssue({ code: 'custom', message });
		return errors.length ? z.NEVER : ops;
	});
export const Ops = opsReplacing();

/** SHA-256 hex of the ops as RFC 8785 canonical JSON (engine canonicalJson): `scenario.ops_sha256` and the run snapshot's `opsSha256`. */
export const opsSha256 = (ops: readonly ScenarioOp[]): string => createHash('sha256').update(canonicalJson(ops)).digest('hex');

const name = z
	.string()
	.trim()
	.min(1, 'a scenario needs a name')
	.max(200)
	.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters');
const description = z
	.string()
	.max(4000)
	.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters');
/** An answer to one of Appendix C's fixed prompts (129_scenario_statement): trimmed, so whitespace alone is "Not given". */
const promptAnswer = z
	.string()
	.trim()
	.max(APPLICANT_PROMPT_MAX)
	.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters');
const ownedNodeIds = z
	.array(z.string().uuid())
	.max(500)
	.transform((xs) => [...new Set(xs)]);

export const SCENARIO_STATUSES = ['draft', 'submitted', 'withdrawn', 'decided'] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

/**
 * Status changes the API (and the scenario_guard trigger) allow. Who may make
 * them (045_contributor_scope): on a team scenario an editor; on an
 * application its owner, except `decided`, which only an editor who isn't
 * its owner makes (POST …/decide).
 */
export const STATUS_MOVES: Record<ScenarioStatus, readonly ScenarioStatus[]> = {
	draft: ['submitted'],
	submitted: ['withdrawn', 'decided'],
	withdrawn: ['draft'],
	decided: []
};

export const CreateScenarioBody = z
	.object({
		name,
		description: description.default(''),
		purposeAndNeed: promptAnswer.default(''),
		mitigation: promptAnswer.default(''),
		monitoring: promptAnswer.default(''),
		baseRunId: z.string().uuid(),
		ops: Ops.default([]),
		ownedNodeIds: ownedNodeIds.default([])
	})
	.strict();

/**
 * Where written objections to an application go, and by when, as its notice gives them (GN R267 reg 17(4)(b)(vi)–(vii);
 * 166_public_participation). Printed beside the warning that a comment in the app is not an objection. '' or null clears.
 */
export const objectionAddress = z
	.string()
	.max(500)
	.transform((s) => s.replace(/\r\n?/g, '\n').trim())
	.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters')
	.nullable()
	.transform((s) => (s ? s : null));
export const objectionClosingDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date, YYYY-MM-DD')
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'must be a real date')
	.nullable();

/**
 * PATCH: `ops` replaces the whole list. Ops, owned nodes and the base change only while the scenario is a draft.
 * `ops` is read here as it came; the route checks it against the scenario's stored ops (parsePatchOps), which a
 * list may keep names from (issue #385).
 */
export const PatchScenarioBody = z
	.object({
		name: name.optional(),
		description: description.optional(),
		purposeAndNeed: promptAnswer.optional(),
		mitigation: promptAnswer.optional(),
		monitoring: promptAnswer.optional(),
		/** An application's only, while it is a draft (scenario_objection_frozen). */
		objectionAddress: objectionAddress.optional(),
		objectionClosingDate: objectionClosingDate.optional(),
		ops: z.unknown().optional(),
		ownedNodeIds: ownedNodeIds.optional(),
		status: z.enum(SCENARIO_STATUSES).optional()
	})
	.strict()
	.refine(
		(b) => Object.values(b).some((v) => v !== undefined),
		'send at least one of name, description, purposeAndNeed, mitigation, monitoring, objectionAddress, objectionClosingDate, ops, ownedNodeIds, status'
	);

/** A PATCH's `ops`, checked as replacing `stored`; a ZodError at path `ops` like any body field. */
export const parsePatchOps = (raw: unknown, stored: readonly ScenarioOp[]): ScenarioOp[] => z.object({ ops: opsReplacing(stored) }).parse({ ops: raw }).ops;

export const RebaseBody = z.object({ baseRunId: z.string().uuid(), dryRun: z.boolean().default(false) }).strict();

export const ScenarioRunBody = z.object({ label: z.string().trim().max(200).optional() }).strict();

/**
 * The responsible authority's decision on an application, in the National
 * Water Act's and GN R267's words (163_licensing_authority; provisional
 * position, pre-counsel research, 2026-10-01): a licence issued (every
 * licence carries conditions, s28(1)(d)) or refused (s42), an application
 * rejected on its formal requirements (R267 regs 9, 11, 12), or not
 * considered because the use is already authorised (s40(4)).
 */
export const SCENARIO_OUTCOMES = ['licence_issued', 'licence_refused', 'application_rejected', 'not_considered'] as const;
export type ScenarioOutcome = (typeof SCENARIO_OUTCOMES)[number];

/**
 * POST …/decide ("Record the authority's decision"): the outcome, the
 * authority's name (default: settings.responsibleAuthority.name), the date on
 * its decision letter, its licence or file reference, whether its written
 * reasons were received, and the recorder's note (scenario.decision_note,
 * ≤ 4000 characters).
 */
export const DecideBody = z
	.object({
		outcome: z.enum(SCENARIO_OUTCOMES),
		authority: z.string().trim().min(1).max(200).optional(),
		decisionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'not a real date'),
		reference: z.string().trim().max(200).default(''),
		reasonsReceived: z.boolean(),
		note: description.default('')
	})
	.strict();

/**
 * POST …/members: whom to share an application with. `userId`, one of the
 * people …/share-candidates lists; or, for a viewer and up only (who read
 * the member list anyway), `email` (049: an applicant never probes an address).
 */
export const ShareBody = z.union([
	z.object({ userId: z.string().uuid() }).strict(),
	z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict()
]);
