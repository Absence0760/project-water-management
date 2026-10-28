// The assistant's settings recommendation (issue #610): the model names the
// changes it recommends and why, and this tool turns them into a settings
// patch checked as a save checks it, without saving anything. A patch the
// save would refuse never reaches the page: SettingsPatch (zod), then the
// save's own checks over the stored settings (projects/settings.ts
// checkedSettingsPatch, which PATCH /projects/:id runs too), then the
// engine's settings resolver (a value the run would replace with a default
// is refused too). The page shows the engine's input-diff lines
// (compare.ts diffInputs) and Apply loads the patch into the Settings draft;
// the user saves it with the normal Save, which checks it again.
import { diffInputs, resolveRunSettings, type ProjectModel, type ProjectSettings } from '@water-management/engine';
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { loadModel } from '../../model/store.js';
import { checkedSettingsPatch, mergeSettings, REPLACED_WHOLE, SettingsPatch } from '../../projects/settings.js';
import { REASON_MAX } from '../../history/record.js';
import { TOOL_NAMES, type AssistantTool, type SettingsProposal, type ToolContext, type ToolResult } from '../types.js';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Changes one proposal may carry. */
export const MAX_CHANGES = 20;
/** The summary becomes the revision's reason ("Assistant suggestion: …"), so it leaves room for the prefix. */
export const SUMMARY_MAX = 200;

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
	// Run policy and what the pages show, not model inputs: get_settings never shows them either (settings.ts NOT_MODEL_INPUT).
	autoRun: 'when the model runs by itself is run policy, not a modelling setting',
	outcomes: 'the outcome settings choose what the results pages show, not how the model runs',
	outlook: 'the seasonal outlook settings choose what the outlook shows, not how the model runs',
	ewrHeadline: 'the EWR headline chooses what the results pages lead with, not how the model runs'
};

const Change = z
	.object({
		key: z.string().trim().min(1).max(80),
		value: z.unknown(),
		reason: z.string().trim().min(1).max(REASON_MAX)
	})
	.strict();
const Args = z
	.object({
		changes: z.array(Change).min(1).max(MAX_CHANGES),
		summary: z.string().trim().min(1).max(SUMMARY_MAX)
	})
	.strict();

/** Every top-level key a settings save accepts (SettingsPatch's own shape). */
export const SETTING_KEYS: readonly string[] = Object.keys(SettingsPatch.shape);

const DESCRIPTION = [
	'Propose a change to the project’s settings for the user to review. Nothing is saved: the user sees the change as a diff and decides whether to apply and save it.',
	'Each change names one setting by its key in get_settings: a top-level key (`lakeEvapFactor`, `pe`) with its whole new value, or one field of a settings group as `group.field` (`gr4j.x1`, `calibration.rainThresholdMm`, `dataQuality.outlierFactorFlow`).',
	'Groups that are one whole thing (fitRecord, pe, arealRain, unitRain, droughtRestriction and the like) take their whole value under the top-level key.',
	'Give each change a reason grounded in the run you read, and a one-line summary of the whole proposal.',
	'The server checks the change as a save would; if it answers ok: false, read the error, fix the value and call again, or tell the user why the change cannot be made.'
].join(' ');

const PARAMETERS = {
	type: 'object',
	additionalProperties: false,
	required: ['changes', 'summary'],
	properties: {
		changes: {
			type: 'array',
			minItems: 1,
			maxItems: MAX_CHANGES,
			description: 'The settings to change, one entry per setting.',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['key', 'value', 'reason'],
				properties: {
					key: { type: 'string', description: 'A top-level settings key, or `group.field` for one field of a settings group.' },
					value: { description: 'The new value, in the shape get_settings shows (a number, string, boolean, array, object or null).' },
					reason: { type: 'string', maxLength: REASON_MAX, description: 'Why this change, from what the run shows.' }
				}
			}
		},
		summary: { type: 'string', maxLength: SUMMARY_MAX, description: 'One line for the whole proposal; it becomes the reason kept with the saved revision.' }
	}
};

/** JSON with object keys sorted, so two equal values compare equal whatever order their keys were written in. */
const stableJson = (v: unknown): string =>
	JSON.stringify(v ?? null, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** A value for a diff line the engine has no words for: short JSON. */
const shortJson = (v: unknown): string => {
	const s = stableJson(v);
	return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

/** The model's changes as one patch, or why not. `current` is the stored settings merged over the defaults. */
export function buildPatch(changes: z.infer<typeof Change>[], current: Json): { patch: Json; reasons: Record<string, string> } | { error: string } {
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
		reasons[top] = reasons[top] ? `${reasons[top]}; ${c.reason}` : c.reason;
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
 * The diff lines between the stored and the patched settings: the engine's
 * own (diffInputs, settings lines only, node ids named from the network).
 * For a setting the engine has no words for (the run policy groups, which
 * aren't model inputs) it says only `Setting "<key>" changed`; that line
 * shows the values before and after as short JSON instead.
 */
export function proposalDiff(before: ProjectSettings, after: ProjectSettings, model: ProjectModel): SettingsProposal['diff'] {
	const snap = (settings: ProjectSettings) => ({ settings: settings as unknown as Json, model, series: {} });
	const b = before as unknown as Json;
	const a = after as unknown as Json;
	const lines: SettingsProposal['diff'] = [];
	for (const c of diffInputs(snap(before), snap(after))) {
		if (c.area !== 'settings') continue;
		if (c.text === `Setting "${c.subject}" changed`) {
			lines.push({ label: c.subject, before: shortJson(b[c.subject]), after: shortJson(a[c.subject]) });
			continue;
		}
		const rest = c.text.startsWith(`${c.subject}: `) ? c.text.slice(c.subject.length + 2) : c.text;
		const arrow = rest.indexOf(' → ');
		lines.push(arrow >= 0 ? { label: c.subject, before: rest.slice(0, arrow), after: rest.slice(arrow + 3) } : { label: c.subject, before: '', after: rest });
	}
	return lines;
}

export async function proposeSettings(ctx: ToolContext, args: unknown): Promise<ToolResult> {
	if (typeof args === 'string') return { ok: false, error: 'the arguments were not valid JSON: send { changes: [{ key, value, reason }], summary }' };
	const parsed = Args.safeParse(args);
	if (!parsed.success) return { ok: false, error: `the arguments don’t fit: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}` };

	const { rows } = await ctx.db.query<{ settings: unknown; time_zone: string }>('SELECT settings, time_zone FROM project WHERE id = $1', [ctx.projectId]);
	if (!rows[0]) return { ok: false, error: 'the project is not visible' };
	const stored = rows[0].settings;
	const before = mergeSettings(stored);

	const built = buildPatch(parsed.data.changes, before as unknown as Json);
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

	const diff = proposalDiff(before, after, await loadModel(ctx.db, ctx.projectId));
	if (!diff.length) return { ok: false, error: 'this changes nothing: the settings already have these values' };

	const proposal: SettingsProposal = { patch: valid.data as Json, reasons: built.reasons, summary: parsed.data.summary, diff };
	return {
		ok: true,
		data: { proposed: true, changes: diff.length, summary: proposal.summary, note: 'Shown to the user as a diff to review; nothing is saved unless they apply it and save.' },
		proposal
	};
}

export const proposeSettingsTool: AssistantTool = {
	spec: { name: TOOL_NAMES.proposeSettings, description: DESCRIPTION, parameters: PARAMETERS },
	label: 'Checking a settings change',
	run: proposeSettings
};
