// The assistant's recommended change (issue #610; reshaped by issue #640):
// the model names a goal and the changes it recommends, each with its reason,
// and this tool checks them as the app would, without saving anything.
//
// The goal decides what may change (settingKinds.ts GOAL_ALLOWS), so a
// calibrated parameter (GR4J's X1–X4, the pan coefficients, the CHIRPS bias
// factors) can't be tuned to make the EWR, a yield or the assurance look
// better: that is a recalibration's only, judged by the fit.
//
// - `outcome` (the EWR, yield, assurance, supply): management levers only,
//   tried as a scenario on the conversation's run, because that is where the
//   app judges a management change against its base (and where the
//   EWR-keeping rules run at all, docs/model.md §2.9g). The levers: a unit's
//   dam runoff capture, diversion, minimum level and release, its hands-off
//   flow, supply rule, river pump and borehole rule, irrigation efficiency,
//   an other user's fixed restriction (MANAGEMENT_NODE_FIELDS); a transfer's
//   months, rates, caps, storage floor, priority and hands-off flow
//   (MANAGEMENT_TRANSFER_FIELDS); demand scaled (demand.scale); and the
//   management settings (the drought restriction, the allocation mode). The
//   ops are checked as the scenario routes check them (scenarios/schema.ts
//   checkOps), then applied to the run's input (engine applyScenario): any
//   problem is the tool's error. Apply on the card creates the scenario.
// - `recalibration` (the fit) and `correction` (a setup error the run shows):
//   a settings patch, checked as a save checks it: SettingsPatch (zod), the
//   save's own checks over the stored settings (projects/settings.ts
//   checkedSettingsPatch, which PATCH /projects/:id runs too), then the
//   engine's settings resolver. Apply puts it in the Settings form.
//
// The card can never claim what it doesn't change: there is no free-text
// title. The server builds the title from the changes it accepted, and each
// change carries its own reason beside the engine's input-diff lines for it
// (compare.ts diffInputs).
import {
	applyScenario,
	diffInputs,
	resolveRunSettings,
	SETTINGS_PATHS,
	type ModelInput,
	type ProjectModel,
	type ProjectSettings,
	type ScenarioOp
} from '@water-management/engine';
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { loadModel } from '../../model/store.js';
import { checkedSettingsPatch, mergeSettings, REPLACED_WHOLE, SettingsPatch } from '../../projects/settings.js';
import { REASON_MAX } from '../../history/record.js';
import { loadBaseInput } from '../../scenarios/execute.js';
import { checkOps } from '../../scenarios/schema.js';
import { GOAL_ALLOWS, GOAL_TITLE, kindRefusal, PROPOSAL_GOALS, SETTING_KINDS, type ProposalGoal } from '../settingKinds.js';
import { TOOL_NAMES, type AssistantProposal, type AssistantTool, type ProposalChange, type ToolContext, type ToolResult } from '../types.js';
import { findNode, NO_RUN, runFor } from './common.js';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Changes one proposal may carry. */
export const MAX_CHANGES = 20;
/** The card's title, built from the changes; it becomes the revision's reason or the scenario's name, so it stays short. */
export const TITLE_MAX = 180;

/**
 * Settings the assistant never proposes, though a save accepts them from a
 * person: each records a person's own act, not a modelling choice. A fit
 * record is a calibration someone ran (an automated one only the server
 * writes); the calibration rules carry a named sign-off; the evidence
 * uncertainty rule is a declaration an evidence report cites; and the
 * responsible authority is who decides the project's applications.
 */
export const NOT_PROPOSED: Readonly<Record<string, string>> = {
	fitRecord: 'a fit record is written by running a calibration (the Calibration page), not proposed',
	calibrationRules: 'the calibration rules carry a person’s sign-off, so a person edits them on the Calibration page',
	evidenceUncertaintyRule: 'the evidence uncertainty rule is a declaration a person makes for an evidence report',
	responsibleAuthority: 'who decides the project’s applications is the owner’s choice, not a modelling setting',
	checksKept: 'a data check kept as recorded is a person’s judgement on the Warnings page, not a modelling setting',
	warningsKept: 'a warning kept is a person’s judgement on the Warnings page, not a modelling setting',
	// Run policy and what the pages show, not model inputs: get_settings never shows them either (settings.ts NOT_MODEL_INPUT).
	autoRun: 'when the model runs by itself is run policy, not a modelling setting',
	outcomes: 'the outcome settings choose what the results pages show, not how the model runs',
	outlook: 'the seasonal outlook settings choose what the outlook shows, not how the model runs',
	ewrHeadline: 'the EWR headline chooses what the results pages lead with, not how the model runs'
};

/**
 * A unit's (or other water user's) fields an outcome may change, in words: how
 * its water is managed, never what the catchment is (its area, a dam's
 * capacity, survey and losses, the river's bed losses are the model of
 * nature, and the scenario form classes them baseline assumptions).
 */
export const MANAGEMENT_NODE_FIELDS: Readonly<Record<string, string>> = {
	pctRunoffToDam: 'own runoff to dam',
	pctUpstreamToDam: 'upstream inflow to dam',
	divertCapacityM3Day: 'river to dam diversion capacity',
	divertMonthlyM3Day: 'river to dam by month',
	damMinPct: 'dam minimum operating level',
	damReleaseRule: 'dam release rule',
	damReleaseM3Day: 'dam release by month',
	damOutletCapacityM3Day: 'dam outlet capacity',
	handsOffM3Day: 'hands-off flow by month',
	handsOffEwr: 'hands-off flow keeps the EWR',
	supplyRule: 'supply rule',
	pumpCapacityM3Day: 'river pump capacity',
	supplyTriggerPct: 'supply trigger level',
	supplyStopPct: 'supply stop level',
	boreholeRule: 'borehole rule',
	boreholeTriggerPct: 'borehole drought trigger',
	irrigationEfficiency: 'irrigation efficiency',
	cropWaterSource: 'crops’ water source',
	cropRiverPumpM3Day: 'crops’ river pump capacity',
	cropRiverPoolM3: 'crops’ river pool',
	userRestrictionPct: 'fixed restriction'
};

/** A transfer rule's fields an outcome may change, in words (not its ends: moving a transfer is a new network, not an operating rule). */
export const MANAGEMENT_TRANSFER_FIELDS: Readonly<Record<string, string>> = {
	months: 'months',
	maxRateM3s: 'maximum rate',
	monthlyRateM3s: 'rate by month',
	dailyCapM3: 'daily cap',
	minStoragePct: 'minimum dam storage to transfer',
	enabled: 'on or off',
	priority: 'priority',
	handsOffM3Day: 'hands-off flow',
	handsOffEwr: 'hands-off flow keeps the EWR'
};

const reason = z.string().trim().min(1).max(REASON_MAX);
const Change = z
	.object({
		key: z.string().trim().min(1).max(80).optional(),
		node: z.string().trim().min(1).max(200).optional(),
		transfer: z.string().trim().min(1).max(420).optional(),
		field: z.string().trim().min(1).max(80).optional(),
		demand: z
			.object({
				factor: z.number(),
				nodes: z.array(z.string().trim().min(1).max(200)).min(1).max(200).optional(),
				months: z.array(z.number().int()).min(1).max(12).optional(),
				category: z.enum(['farm', 'user']).optional()
			})
			.strict()
			.optional(),
		value: z.unknown().optional(),
		reason
	})
	.strict();
type ChangeIn = z.infer<typeof Change>;
const Args = z
	.object({
		goal: z.enum(PROPOSAL_GOALS),
		changes: z.array(Change).min(1).max(MAX_CHANGES)
	})
	.strict();

/** Every top-level key a settings save accepts (SettingsPatch's own shape). */
export const SETTING_KEYS: readonly string[] = Object.keys(SettingsPatch.shape);

const DESCRIPTION = [
	'Propose a change for the user to review. Nothing is saved: the user sees each change with your reason and decides.',
	'First choose the goal. "outcome": improve the EWR, a yield, the assurance or supply; only management levers may change, and the change is tried as a scenario on the run, so the user can run it and compare. "recalibration": improve the fit to observed flow; calibrated parameters (gr4j, panCoefficient, pe, the CHIRPS bias settings) and inputs. "correction": fix a setup error the run shows; inputs and assessment settings. get_settings lists each setting’s kind; a calibrated parameter is never changed for an outcome.',
	'Each change is one of: a setting by its get_settings key (`key`: a top-level key with its whole value, or `group.field` such as `gr4j.x1`); a field of a unit or other water user (`node`: its id or name from get_network, `field`, `value`); a field of a transfer (`transfer`: its id, or "From → To" by the units’ names, `field`, `value`); or demand scaled (`demand`: { factor 0–2, nodes?, months? (calendar months 1–12), category? }), outcome only.',
	`Unit fields an outcome may change: ${Object.keys(MANAGEMENT_NODE_FIELDS).join(', ')}. Transfer fields: ${Object.keys(MANAGEMENT_TRANSFER_FIELDS).join(', ')}. Settings: droughtRestriction, allocationMode.`,
	'Give every change a reason grounded in what you read. There is no title to write: the card’s title is built from the changes you make, so propose only what you describe.',
	'The server checks the change as the app would; if it answers ok: false, read the error, fix the change and call again, or tell the user plainly why it cannot be made (for an outcome: when no management lever exists).'
].join(' ');

const PARAMETERS = {
	type: 'object',
	additionalProperties: false,
	required: ['goal', 'changes'],
	properties: {
		goal: {
			type: 'string',
			enum: [...PROPOSAL_GOALS],
			description: 'outcome: improve the EWR, yield, assurance or supply (management levers only); recalibration: improve the fit to observed flow; correction: fix a setup error.'
		},
		changes: {
			type: 'array',
			minItems: 1,
			maxItems: MAX_CHANGES,
			description: 'The changes, one entry each: a setting (key), a unit’s field (node + field), a transfer’s field (transfer + field), or demand scaled (demand).',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['reason'],
				properties: {
					key: { type: 'string', description: 'A setting: a top-level settings key, or `group.field` for one field of a settings group.' },
					node: { type: 'string', description: 'A unit or other water user: its id or name, as get_network lists it.' },
					transfer: { type: 'string', description: 'A transfer: its id from get_network, or "From → To" by the units’ names.' },
					field: { type: 'string', description: 'With node or transfer: the field to change.' },
					demand: {
						type: 'object',
						additionalProperties: false,
						required: ['factor'],
						description: 'Demand scaled (outcome only): factor 0–2, optionally only some units (names or ids), months (1–12) or the other water users (category "user").',
						properties: {
							factor: { type: 'number' },
							nodes: { type: 'array', items: { type: 'string' } },
							months: { type: 'array', items: { type: 'integer' } },
							category: { type: 'string', enum: ['farm', 'user'] }
						}
					},
					value: { description: 'The new value, in the shape get_settings or get_network shows (a number, string, boolean, array, object or null). Not with demand.' },
					reason: { type: 'string', maxLength: REASON_MAX, description: 'Why this change, from what the run shows.' }
				}
			}
		}
	}
};

/** JSON with object keys sorted, so two equal values compare equal whatever order their keys were written in. */
const stableJson = (v: unknown): string =>
	JSON.stringify(v ?? null, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** A value for a line the engine has no words for: short JSON. */
const shortJson = (v: unknown): string => {
	const s = stableJson(v);
	return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

/** What a change targets: exactly one of key, node, transfer and demand. */
type Target = { kind: 'setting'; key: string } | { kind: 'node'; ref: string; field: string } | { kind: 'transfer'; ref: string; field: string } | { kind: 'demand' };

function targetOf(c: ChangeIn, i: number): Target | { error: string } {
	const named = [c.key && 'key', c.node && 'node', c.transfer && 'transfer', c.demand && 'demand'].filter(Boolean);
	if (named.length !== 1) return { error: `changes.${i}: name exactly one of key, node, transfer or demand${named.length ? ` (it names ${named.join(' and ')})` : ''}` };
	if (c.demand) {
		if (c.value !== undefined || c.field) return { error: `changes.${i}: demand takes its factor inside it, with no field or value` };
		return { kind: 'demand' };
	}
	if (c.value === undefined) return { error: `${c.key ?? c.field ?? `changes.${i}`}: no value given` };
	if (c.key) {
		if (c.field) return { error: `${c.key}: a setting takes no field (name one field of a group as group.field)` };
		return { kind: 'setting', key: c.key };
	}
	if (!c.field) return { error: `changes.${i}: name the field of the ${c.node ? 'unit' : 'transfer'} to change` };
	return c.node ? { kind: 'node', ref: c.node, field: c.field } : { kind: 'transfer', ref: c.transfer!, field: c.field };
}

/** Why a change can't serve the goal, or null. Settings by their kind (settingKinds.ts); the network's levers and demand are management. */
export function goalProblem(target: Target, goal: ProposalGoal): string | null {
	if (target.kind === 'setting') {
		const top = target.key.split('.')[0]!;
		const kind = SETTING_KINDS[top];
		if (!kind) return null; // unknown or never proposed: buildPatch / the outcome path says why
		return GOAL_ALLOWS[goal].includes(kind) ? null : `${target.key}: ${kindRefusal(kind, goal)}`;
	}
	if (goal === 'outcome') return null;
	const what = target.kind === 'demand' ? 'demand' : `${target.ref}: ${target.field}`;
	return `${what}: a management lever is changed to improve an outcome (goal "outcome"), where it is tried as a scenario; a ${goal} changes settings only`;
}

/** The model's setting changes as one patch, or why not. `current` is the stored settings merged over the defaults. */
export function buildPatch(changes: { key: string; value: unknown; reason: string }[], current: Json): { patch: Json; reasons: Record<string, string> } | { error: string } {
	const patch: Json = {};
	const reasons: Record<string, string> = {};
	const seen = new Set<string>();
	const whole = new Set<string>();
	for (const c of changes) {
		if (c.value === undefined) return { error: `${c.key}: no value given` };
		const parts = c.key.split('.');
		const top = parts[0]!;
		if (parts.length > 2 || parts.some((p) => !p)) return { error: `${c.key}: name a top-level setting or one field of a group (group.field)` };
		if (!SETTING_KEYS.includes(top)) return { error: `${top}: not a setting of this project (get_settings lists them)` };
		if (NOT_PROPOSED[top]) return { error: `${top}: ${NOT_PROPOSED[top]}` };
		if (seen.has(c.key)) return { error: `${c.key}: named twice` };
		seen.add(c.key);
		if (parts.length === 2) {
			if (REPLACED_WHOLE.has(top) || !isObj(current[top])) return { error: `${c.key}: ${top} is changed whole, under the key ${top}` };
			if (whole.has(top)) return { error: `${top}: changed whole and field by field in one proposal` };
			patch[top] = { ...((patch[top] as Json | undefined) ?? {}), [parts[1]!]: c.value };
		} else {
			if (top in patch) return { error: `${top}: changed whole and field by field in one proposal` };
			patch[top] = c.value;
			whole.add(top);
		}
		reasons[c.key] = c.reason;
	}
	return { patch, reasons };
}

/** The first few problems zod found, as one sentence the model can act on. */
function zodProblems(err: z.ZodError): string {
	const lines = err.issues.slice(0, 5).map((i) => `${i.path.length ? i.path.join('.') : 'settings'}: ${i.message}`);
	return `the save would refuse this: ${lines.join('; ')}${err.issues.length > 5 ? ` (and ${err.issues.length - 5} more)` : ''}`;
}

/** What the engine's resolver would warn about with the patch that it doesn't with the stored settings: a value the run would replace. */
export function resolverObjections(before: ProjectSettings, after: ProjectSettings): string[] {
	const was: string[] = [];
	const now: string[] = [];
	resolveRunSettings(before as never, was);
	resolveRunSettings(after as never, now);
	const known = new Set(was);
	return now.filter((w) => !known.has(w));
}

/**
 * The engine's input-diff lines (diffInputs) between two inputs, as sentences.
 * A setting the engine has no words for (it says only `Setting "<key>"
 * changed`) is shown with its values before and after as short JSON.
 */
export function diffLines(before: { settings: unknown; model: ProjectModel }, after: { settings: unknown; model: ProjectModel }): string[] {
	const snap = (x: { settings: unknown; model: ProjectModel }) => ({ settings: x.settings as Json, model: x.model, series: {} });
	const b = before.settings as Json;
	const a = after.settings as Json;
	return diffInputs(snap(before), snap(after)).map((c) =>
		c.area === 'settings' && c.text === `Setting "${c.subject}" changed` ? `${c.subject}: ${shortJson(b[c.subject])} → ${shortJson(a[c.subject])}` : c.text
	);
}

/** The diff lines' subjects for a short label: "GR4J X1: 350 → 420" gives "GR4J X1". */
const labelOf = (line: string) => {
	const arrow = line.indexOf(' → ');
	const head = arrow >= 0 ? line.slice(0, arrow) : line;
	const colon = head.indexOf(': ');
	return colon >= 0 ? head.slice(0, colon) : head;
};

/** The card's title from the accepted changes' labels: never the model's words. */
export function proposalTitle(goal: ProposalGoal, labels: readonly string[]): string {
	const head = `${GOAL_TITLE[goal]}: `;
	const unique = [...new Set(labels)];
	let title = head + unique[0];
	let i = 1;
	for (; i < unique.length; i++) {
		const more = unique.length - i - 1;
		const next = `${title}; ${unique[i]}`;
		if (next.length + (more ? ` and ${more} more`.length : 0) > TITLE_MAX) break;
		title = next;
	}
	if (i < unique.length) title += ` and ${unique.length - i} more`;
	return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

// ---- recalibration and correction: a settings patch --------------------------------

async function settingsProposal(ctx: ToolContext, goal: ProposalGoal, changes: { key: string; value: unknown; reason: string }[]): Promise<ToolResult> {
	const { rows } = await ctx.db.query<{ settings: unknown; time_zone: string }>('SELECT settings, time_zone FROM project WHERE id = $1', [ctx.projectId]);
	if (!rows[0]) return { ok: false, error: 'the project is not visible' };
	const stored = rows[0].settings;
	const before = mergeSettings(stored);

	const built = buildPatch(changes, before as unknown as Json);
	if ('error' in built) return { ok: false, error: built.error };
	const valid = SettingsPatch.safeParse(built.patch);
	if (!valid.success) return { ok: false, error: zodProblems(valid.error) };

	let after: ProjectSettings;
	try {
		({ settings: after } = await checkedSettingsPatch(ctx.db, ctx.projectId, stored, valid.data, rows[0].time_zone));
	} catch (err) {
		// The save's own refusal, worded for a client already; anything else (the database) is not the model's to read.
		if (err instanceof ApiError) return { ok: false, error: `the save would refuse this: ${err.message}` };
		throw err;
	}
	const objections = resolverObjections(before, after);
	if (objections.length) return { ok: false, error: `the run would not use this as given: ${objections.slice(0, 3).join('; ')}` };

	const model = await loadModel(ctx.db, ctx.projectId);
	const b = before as unknown as Json;
	const a = after as unknown as Json;
	const out: ProposalChange[] = [];
	for (const c of changes) {
		const [top, field] = c.key.split('.') as [string, string | undefined];
		// This change alone over the stored settings, so its lines are its own.
		const alone = { ...b, [top]: field ? { ...(b[top] as Json), [field]: (a[top] as Json)[field] } : a[top] };
		const lines = diffLines({ settings: before, model }, { settings: alone, model });
		if (!lines.length) return { ok: false, error: `${c.key}: this changes nothing: the setting already has this value` };
		out.push({ label: labelOf(lines[0]!), lines, reason: c.reason });
	}
	const proposal: AssistantProposal = { goal, title: proposalTitle(goal, out.map((c) => c.label)), changes: out, apply: { kind: 'settings', patch: valid.data as Json } };
	return accepted(proposal, 'Shown to the user to review; Apply puts it in the settings form, and nothing is saved unless they save it.');
}

// ---- outcome: management levers, as a scenario on the run --------------------------

/** What an outcome proposal is built from: the run the scenario is based on and its input. Injected in the unit tests. */
export type LoadBase = (ctx: ToolContext) => Promise<{ runId: string; input: ModelInput } | { error: string }>;

export const loadRunBase: LoadBase = async (ctx) => {
	try {
		// The caller's role (viewer or above: RLS hides a project they aren't in) and the conversation's run, else the latest.
		const { role, runId } = await runFor(ctx);
		if (!runId) return { error: NO_RUN };
		return { runId, input: await loadBaseInput(ctx.db, ctx.projectId, runId, role) };
	} catch (err) {
		if (err instanceof ApiError) return { error: err.message };
		throw err;
	}
};

/** A transfer named by its id, or "From → To" by its units' names (any case). */
function findTransfer(model: ProjectModel, ref: string): { id: string; label: string } | { error: string } {
	const nodes = model.nodes ?? [];
	const nameOf = (id: string | null) => (id === null ? 'outside the catchment' : (nodes.find((n) => n.id === id)?.name ?? id));
	const label = (t: { fromNodeId: string; toNodeId: string | null }) => `${nameOf(t.fromNodeId)} → ${nameOf(t.toNodeId)}`;
	const transfers = model.transfers ?? [];
	const byId = transfers.find((t) => t.id === ref.trim());
	if (byId) return { id: byId.id, label: label(byId) };
	const norm = (s: string) => s.replace(/->/g, '→').replace(/\s+/g, ' ').trim().toLowerCase();
	const hits = transfers.filter((t) => norm(label(t)) === norm(ref));
	if (hits.length === 1) return { id: hits[0]!.id, label: label(hits[0]!) };
	if (hits.length > 1) return { error: `transfer "${ref}": ${hits.length} transfers run between those units; name one by its id (${hits.map((t) => t.id).join(', ')})` };
	return { error: `transfer "${ref}": not found (name it by its id from get_network, or "From → To")` };
}

/** One change as the scenario ops that make it, with its label, or why not. */
function opsFor(c: ChangeIn, target: Target, model: ProjectModel): { ops: ScenarioOp[]; label: string; nodeId?: string } | { error: string } {
	if (target.kind === 'setting') {
		const kind = SETTING_KINDS[target.key];
		if (kind !== 'management' || !(SETTINGS_PATHS as readonly string[]).includes(target.key)) return { error: `${target.key}: not a management setting a scenario can change` };
		return { ops: [{ op: 'settings.set', path: target.key, value: c.value } as ScenarioOp], label: target.key === 'droughtRestriction' ? 'drought restriction rule' : 'allocation mode' };
	}
	if (target.kind === 'node') {
		const words = MANAGEMENT_NODE_FIELDS[target.field];
		if (!words) return { error: `${target.ref}: ${target.field} is not a management lever the assistant may change (it may change ${Object.keys(MANAGEMENT_NODE_FIELDS).join(', ')})` };
		const node = findNode(model.nodes ?? [], target.ref);
		if (!node) return { error: `${target.ref}: no unit or water user of that id or name in the run’s network` };
		return { ops: [{ op: 'node.set', nodeId: node.id, field: target.field, value: c.value } as ScenarioOp], label: `${node.name}: ${words}`, nodeId: node.id };
	}
	if (target.kind === 'transfer') {
		const words = MANAGEMENT_TRANSFER_FIELDS[target.field];
		if (!words) return { error: `${target.ref}: ${target.field} is not a transfer rule the assistant may change (it may change ${Object.keys(MANAGEMENT_TRANSFER_FIELDS).join(', ')})` };
		const t = findTransfer(model, target.ref);
		if ('error' in t) return t;
		return { ops: [{ op: 'transfer.set', transferId: t.id, field: target.field, value: c.value } as ScenarioOp], label: `transfer ${t.label}: ${words}` };
	}
	const d = c.demand!;
	const ids: string[] = [];
	for (const ref of d.nodes ?? []) {
		const n = findNode(model.nodes ?? [], ref);
		if (!n) return { error: `demand: no unit or water user "${ref}" in the run’s network` };
		ids.push(n.id);
	}
	const op = { op: 'demand.scale', factor: d.factor, ...(ids.length ? { nodeIds: ids } : {}), ...(d.months ? { months: d.months } : {}), ...(d.category ? { category: d.category } : {}) } as ScenarioOp;
	const whose = ids.length ? (d.nodes ?? []).map((r) => findNode(model.nodes ?? [], r)!.name).join(', ') : d.category === 'user' ? 'other water users' : 'every unit';
	return { ops: [op], label: `demand × ${d.factor} (${whose}${d.months ? `, months ${d.months.join(' ')}` : ''})` };
}

/** The applied ops' problems, as one sentence the model can act on. */
const problemsText = (problems: readonly string[]) => `the scenario would not apply: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`;

export async function outcomeProposal(ctx: ToolContext, changes: { change: ChangeIn; target: Target }[], loadBase: LoadBase = loadRunBase): Promise<ToolResult> {
	const base = await loadBase(ctx);
	if ('error' in base) return { ok: false, error: base.error };
	const model = base.input.model;

	const built: { change: ChangeIn; ops: ScenarioOp[]; label: string; nodeId?: string }[] = [];
	for (const { change, target } of changes) {
		const r = opsFor(change, target, model);
		if ('error' in r) return { ok: false, error: r.error };
		built.push({ change, ...r });
	}
	const keys = built.map((b) => stableJson(b.ops.map((o) => ({ ...o, value: undefined, factor: undefined }))));
	const twice = keys.findIndex((k, i) => keys.indexOf(k) !== i);
	if (twice >= 0) return { ok: false, error: `${built[twice]!.label}: named twice` };

	// A unit's ops side by side, so the save rules tying its fields together are checked once, after them all (scenarios.md § Edit groups).
	const firstAt = new Map<string, number>();
	built.forEach((b, i) => b.nodeId && !firstAt.has(b.nodeId) && firstAt.set(b.nodeId, i));
	const order = built.map((b, i) => ({ b, at: b.nodeId ? firstAt.get(b.nodeId)! : i, i })).sort((x, y) => x.at - y.at || x.i - y.i);
	const ops = order.flatMap((x) => x.b.ops);

	// The scenario routes' own check (the op shapes and UUID ids), then the engine's against the run's input.
	const checked = checkOps(ops);
	if (checked.errors.length) return { ok: false, error: `the scenario would refuse this: ${checked.errors.slice(0, 3).join('; ')}` };
	const all = applyScenario(base.input, checked.ops);
	if (all.problems.length) return { ok: false, error: problemsText(all.problems) };

	const out: ProposalChange[] = [];
	for (const b of built) {
		// This change alone on the run, so its lines are its own. A change the save rules tie to its neighbours (a
		// trigger and a stop level raised together) doesn't apply alone: it shows its new value instead.
		const alone = applyScenario(base.input, b.ops);
		const lines = alone.problems.length ? [`${b.label} → ${shortJson(b.change.value ?? b.change.demand)}`] : diffLines(base.input, alone.input);
		if (!lines.length) return { ok: false, error: `${b.label}: this changes nothing: the run already has this value` };
		out.push({ label: b.label, lines, reason: b.change.reason });
	}
	const proposal: AssistantProposal = {
		goal: 'outcome',
		title: proposalTitle('outcome', out.map((c) => c.label)),
		changes: out,
		apply: { kind: 'scenario', baseRunId: base.runId, ops: checked.ops }
	};
	return accepted(proposal, 'Shown to the user to review; Apply creates a scenario on this run for them to run and compare with it. Nothing changes in the project.');
}

/** The tool's answer to an accepted proposal: what the model is told, and the card. */
function accepted(proposal: AssistantProposal, note: string): ToolResult {
	return {
		ok: true,
		data: { proposed: true, goal: proposal.goal, title: proposal.title, changes: proposal.changes.map((c) => ({ label: c.label, lines: c.lines })), note },
		proposal
	};
}

export async function proposeSettings(ctx: ToolContext, args: unknown, loadBase: LoadBase = loadRunBase): Promise<ToolResult> {
	if (typeof args === 'string') return { ok: false, error: 'the arguments were not valid JSON: send { goal, changes: [{ key | node + field | transfer + field | demand, value, reason }] }' };
	if (isObj(args) && 'summary' in args)
		return { ok: false, error: 'summary: there is no summary to write: the card’s title is built from the changes you make, so it always says what the proposal changes. Drop it and put the why in each change’s reason' };
	const parsed = Args.safeParse(args);
	if (!parsed.success) return { ok: false, error: `the arguments don’t fit: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}` };
	const { goal } = parsed.data;

	const targeted: { change: ChangeIn; target: Target }[] = [];
	for (const [i, change] of parsed.data.changes.entries()) {
		const target = targetOf(change, i);
		if ('error' in target) return { ok: false, error: target.error };
		const problem = goalProblem(target, goal);
		if (problem) return { ok: false, error: problem };
		targeted.push({ change, target });
	}
	if (goal === 'outcome') {
		for (const { target } of targeted) {
			if (target.kind !== 'setting') continue;
			const top = target.key.split('.')[0]!;
			if (NOT_PROPOSED[top]) return { ok: false, error: `${top}: ${NOT_PROPOSED[top]}` };
			if (!SETTING_KEYS.includes(top)) return { ok: false, error: `${top}: not a setting of this project (get_settings lists them)` };
		}
		return outcomeProposal(ctx, targeted, loadBase);
	}
	return settingsProposal(
		ctx,
		goal,
		targeted.map(({ change, target }) => ({ key: (target as { key: string }).key, value: change.value, reason: change.reason }))
	);
}

export const proposeSettingsTool: AssistantTool = {
	spec: { name: TOOL_NAMES.proposeSettings, description: DESCRIPTION, parameters: PARAMETERS },
	label: 'Checking a recommended change',
	run: (ctx, args) => proposeSettings(ctx, args)
};
