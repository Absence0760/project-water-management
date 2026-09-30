// Request bodies for the scenario routes (docs/api.md § Scenarios). The ops
// themselves are checked by the engine's validateScenarioOps, the one
// definition of what an op may hold (packages/engine/src/scenario/ops.ts);
// this wraps it in zod and tightens every id to a UUID, because the rows a
// scenario run writes (run_series.node_id) are uuid columns.
import { createHash } from 'node:crypto';
import { canonicalJson, validateScenarioOps, type ScenarioOp } from '@water-management/engine';
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where each op keeps an id, as paths into the op (`transfer.set`'s `value` is an id only when it sets a transfer end). */
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
				['transfer.toNodeId', op.transfer.toNodeId]
			];
		case 'transfer.set':
			return [['transferId', op.transferId], ...(op.field === 'fromNodeId' || op.field === 'toNodeId' ? ([['value', op.value]] as [string, unknown][]) : [])];
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
 * fields only, so unknown keys never reach the database.
 */
export function checkOps(raw: unknown): { ops: ScenarioOp[]; errors: string[] } {
	const { ops, errors } = validateScenarioOps(raw);
	if (errors.length) return { ops, errors };
	ops.forEach((op, i) => {
		for (const [path, v] of opIds(op)) if (typeof v !== 'string' || !UUID_RE.test(v)) errors.push(`ops[${i}].${path}: must be a UUID`);
	});
	return { ops, errors };
}

/** zod wrapper: the checked ops, or one issue per error. */
export const Ops = z.unknown().transform((raw, ctx) => {
	const { ops, errors } = checkOps(raw);
	for (const message of errors) ctx.addIssue({ code: 'custom', message });
	return errors.length ? z.NEVER : ops;
});

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
	.object({ name, description: description.default(''), baseRunId: z.string().uuid(), ops: Ops.default([]), ownedNodeIds: ownedNodeIds.default([]) })
	.strict();

/** PATCH: `ops` replaces the whole list. Ops, owned nodes and the base change only while the scenario is a draft. */
export const PatchScenarioBody = z
	.object({ name: name.optional(), description: description.optional(), ops: Ops.optional(), ownedNodeIds: ownedNodeIds.optional(), status: z.enum(SCENARIO_STATUSES).optional() })
	.strict()
	.refine((b) => Object.values(b).some((v) => v !== undefined), 'send at least one of name, description, ops, ownedNodeIds, status');

export const RebaseBody = z.object({ baseRunId: z.string().uuid(), dryRun: z.boolean().default(false) }).strict();

export const ScenarioRunBody = z.object({ label: z.string().trim().max(200).optional() }).strict();

/** An assessor's decision on an application (045_contributor_scope; the words are pending the licensing authority). */
export const SCENARIO_OUTCOMES = ['approved', 'approved_with_conditions', 'refused'] as const;
export type ScenarioOutcome = (typeof SCENARIO_OUTCOMES)[number];

/** POST …/decide: the outcome and the assessor's reasons (scenario.decision_note, ≤ 4000 characters). */
export const DecideBody = z.object({ outcome: z.enum(SCENARIO_OUTCOMES), note: description.default('') }).strict();

/**
 * POST …/members: whom to share an application with. `userId`, one of the
 * people …/share-candidates lists; or, for a viewer and up only (who read
 * the member list anyway), `email` (049: an applicant never probes an address).
 */
export const ShareBody = z.union([
	z.object({ userId: z.string().uuid() }).strict(),
	z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict()
]);
