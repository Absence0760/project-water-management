// The server's re-run of a reproduction bundle, one part at a time
// (backend pack_reproduce + pack_reproduce_part jobs, 302_pack_reproduce_parts;
// docs/evidence-pack.md § Reproduction). `pnpm reproduce:pack` runs every
// re-run in one process with no time limit (checkPackBundle); the server's
// worker has 300 s a job, and a pack whose combined row reads an assessment
// can hold up to 160 firm-yield searches (scenario/cumulativeYield.ts), so it
// splits them: planPackBundleReruns checks the bundle without re-running and
// lists the parts (each run, the headline pair, § 8's pairs, the combined
// row's assessment, its background, and one firm-yield search per dam and
// run, as the assessment job fans them out); rerunPackBundlePart runs one;
// foldPackBundleReruns puts their checks together in checkPackBundle's order,
// the dams' yields gathered into one `reproduce:dams` as the assessment's
// gather fills its rows (cumulativeDamRow). The checks are the same as a full
// checkPackBundle's, id for id.
import { cumulativeDamRow, damFirmYields, isCumulativeDam, type CumulativeDam } from '../scenario/cumulativeYield';
import type { CumulativeRow } from '../scenario/cumulative';
import { ENGINE_VERSION } from '../version';
import {
	checkPackBundle,
	type BundleAssessmentContext,
	type BundleCheck,
	type BundleCheckResult,
	type BundlePartKey,
	type CheckPackBundleOptions
} from './bundle';
import { assessmentRunInput, rowDifferences, type AssessmentRunRef } from './bundleAssessment';

/** One firm-yield search: a dam the applications touch, on one run of the assessment. */
export interface BundleDamPart {
	kind: 'dam';
	/** The dam's place in the stored report's `dams.nodeIds`. */
	damPosition: number;
	nodeId: string;
	name: string;
	run: AssessmentRunRef['run'];
	/** The member's place, for a single. */
	memberPosition: number | null;
	/** How the report names the run: "The baseline", "<name>" alone, "All together". */
	label: string;
}

/** A part of the server's re-run. */
export type BundleRerunPart = { kind: BundlePartKey } | BundleDamPart;

/** What a part found. */
export interface BundlePartResult {
	/** Its checks (none for a dam part that found its yield: the fold compares it). */
	checks: BundleCheck[];
	/** A dam part: the firm yield it found, m³/year (null when the search found none), and the search's warnings. */
	damYield?: { yieldM3Year: number | null; warnings: string[] };
}

type Opts = Omit<CheckPackBundleOptions, 'rerun' | 'parts' | 'onAssessment'>;

const FIXED_PART_CHECKS: Record<Exclude<BundlePartKey, `alternative:${number}`>, readonly string[]> = {
	'run:baseline': ['reproduce:baseline'],
	'run:application': ['reproduce:application'],
	headline: ['reproduce:headline'],
	climate: ['climate:delta'],
	combined: ['reproduce:combined', 'reproduce:dams'],
	background: ['reproduce:background']
};
const isAlternativePart = (k: BundlePartKey): k is `alternative:${number}` => k.startsWith('alternative:');

/** The checks each part adds (and only it): an alternative's re-run is `reproduce:alternative:<n>`. */
export const bundlePartChecks = (k: BundlePartKey): readonly string[] => (isAlternativePart(k) ? [`reproduce:${k}`] : FIXED_PART_CHECKS[k]);

/** The check a part reports under when it couldn't run at all. */
export const bundlePartCheckId = (p: BundleRerunPart): string => (p.kind === 'dam' ? 'reproduce:dams' : bundlePartChecks(p.kind)[0]!);

/** A part's name, for a message and the record's lines. */
export function bundlePartLabel(p: BundleRerunPart): string {
	if (p.kind === 'dam') return `the firm yield of "${p.name}" (${p.label})`;
	if (isAlternativePart(p.kind)) return `the run of alternative ${p.kind.slice('alternative:'.length)}`;
	return { 'run:baseline': 'the baseline run', 'run:application': 'the application run', headline: 'the headline pair', climate: '§ 8’s pairs', combined: 'the combined row’s assessment', background: 'its background at full allocation' }[p.kind];
}

/**
 * Check the bundle without re-running it, and list the re-runs it needs: none
 * when a check failed (the outcome is known: not reproduced), otherwise each
 * run, the headline pair, § 8, the combined row's assessment and background,
 * and one firm-yield search per touched dam and run that has the dam.
 */
export async function planPackBundleReruns(bytes: Uint8Array<ArrayBuffer>, opts: Opts): Promise<{ result: BundleCheckResult; parts: BundleRerunPart[] }> {
	let ctx: BundleAssessmentContext | null = null;
	const result = await checkPackBundle(bytes, { ...opts, rerun: false, onAssessment: (c) => (ctx = c) });
	if (!result.ok) return { result, parts: [] };
	const has = (id: string) => result.checks.some((c) => c.id === id);
	const parts: BundleRerunPart[] = [];
	for (const r of ['baseline', 'application'] as const) if (has(`results:${r}`)) parts.push({ kind: `run:${r}` });
	// Each alternative page 1 assesses (bundle-3, evidence-26): its own re-run.
	for (const c of result.checks) if (/^alternative:\d+$/.test(c.id)) parts.push({ kind: c.id as `alternative:${number}` });
	if (result.headline === 'checked') parts.push({ kind: 'headline' });
	if (result.combined === 'checked' && ctx) {
		parts.push({ kind: 'combined' });
		if (has('inputs:background')) parts.push({ kind: 'background' });
		parts.push(...damParts(ctx));
	}
	if (has('climate:delta')) parts.push({ kind: 'climate' });
	return { result, parts };
}

/** One part per touched dam and run that has it (the assessment job's fan-out, backend assessments/yields.ts). */
function damParts(ctx: BundleAssessmentContext): BundleDamPart[] {
	const ids = ctx.report.dams?.nodeIds ?? [];
	const members = ctx.file.members;
	const refs: { ref: AssessmentRunRef; label: string }[] = [
		{ ref: { run: 'baseline' }, label: 'The baseline' },
		...members.map((m, i) => ({ ref: { run: 'single', memberPosition: i } as AssessmentRunRef, label: `"${m.name}" alone` })),
		{ ref: { run: 'combined' }, label: 'All together' }
	];
	const out: BundleDamPart[] = [];
	for (const { ref, label } of refs) {
		let input: ReturnType<typeof assessmentRunInput> | null = null;
		try {
			input = assessmentRunInput(ctx.base, members, ref);
		} catch {
			// The combined part says why; each dam's part on this run says it couldn't be built.
		}
		ids.forEach((nodeId, damPosition) => {
			if (input && !isCumulativeDam(input, nodeId)) return;
			out.push({ kind: 'dam', damPosition, nodeId, name: damName(ctx.report.rows, nodeId), run: ref.run, memberPosition: ref.run === 'single' ? ref.memberPosition : null, label });
		});
	}
	return out;
}

const damName = (rows: readonly CumulativeRow[], nodeId: string) => rows.find((r) => r.siteNodeId === nodeId && r.metric === 'dam_firm_yield')?.site ?? nodeId;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run one part: its re-run's checks, or a dam's firm yield. */
export async function rerunPackBundlePart(bytes: Uint8Array<ArrayBuffer>, part: BundleRerunPart, opts: Opts): Promise<BundlePartResult> {
	const notRun = (why: string): BundlePartResult => ({ checks: [{ id: bundlePartCheckId(part), ok: false, detail: `not re-run: ${why}` }] });
	if (part.kind !== 'dam') {
		const r = await checkPackBundle(bytes, { ...opts, rerun: true, parts: [part.kind] });
		const ids = bundlePartChecks(part.kind);
		const checks = r.checks.filter((c) => ids.includes(c.id));
		return checks.length ? { checks } : notRun(`the bundle failed a check before ${bundlePartLabel(part)} (${r.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'none ran'})`);
	}
	let ctx: BundleAssessmentContext | null = null;
	await checkPackBundle(bytes, { ...opts, rerun: false, onAssessment: (c) => (ctx = c) });
	if (!ctx) return notRun("the combined row's assessment failed a check");
	const c: BundleAssessmentContext = ctx;
	const ref: AssessmentRunRef = part.run === 'single' ? { run: 'single', memberPosition: part.memberPosition ?? -1 } : { run: part.run };
	let input;
	try {
		input = assessmentRunInput(c.base, c.file.members, ref);
	} catch (e) {
		return notRun(`${part.label}: ${message(e)}`);
	}
	const y = damFirmYields(input, [{ nodeId: part.nodeId, name: part.name }], part.label);
	return { checks: [], damYield: { yieldM3Year: y.yields[0] ?? null, warnings: y.warnings } };
}

/** checkPackBundle's order of checks: the fold puts the parts' checks back in it. */
const ORDER = [
	'archive',
	'files',
	'structure',
	'manifest',
	'figure:locality',
	'observations:s2',
	'observations:wofs',
	'observations:days',
	'runs',
	'inputs:baseline',
	'inputs:application',
	'changes',
	'scenario',
	'results:baseline',
	'results:application',
	'reproduce:baseline',
	'reproduce:application',
	'headline',
	'reproduce:headline',
	'assessment',
	'inputs:background',
	'reproduce:combined',
	'reproduce:dams',
	'reproduce:background',
	'climate:delta'
];
const rank = (id: string) => {
	// An alternative's checks come after the runs' re-runs, each alternative's check then its re-run (checkPackBundle's order).
	const alt = /^(reproduce:)?alternative:(\d+)$/.exec(id);
	if (alt) return ORDER.indexOf('reproduce:application') + 0.5 + Number(alt[2]) / 1000 + (alt[1] ? 1 / 4000 : 0);
	const i = ORDER.indexOf(id);
	return i < 0 ? ORDER.length : i;
};

/**
 * The parts' outcome put together: the plan's checks, each part's in place
 * (§ 8's re-run replacing its not-re-run line), and the dams' firm yields
 * gathered into `reproduce:dams`: each touched dam's `dam_firm_yield` row
 * built again from the parts' yields and compared with the stored one, with
 * the combined part's assurance rows. The result checkPackBundle gives with
 * the re-run, check for check.
 */
export async function foldPackBundleReruns(
	bytes: Uint8Array<ArrayBuffer>,
	opts: Opts,
	planned: Pick<BundleCheckResult, 'checks' | 'pack' | 'engine' | 'headline' | 'combined'>,
	done: readonly { part: BundleRerunPart; result: BundlePartResult }[]
): Promise<BundleCheckResult> {
	const fromParts = done.flatMap((d) => d.result.checks.filter((c) => c.id !== 'reproduce:dams' || d.part.kind !== 'dam'));
	const replaced = new Set(fromParts.map((c) => c.id));
	const checks: BundleCheck[] = [...planned.checks.filter((c) => !replaced.has(c.id)), ...fromParts.filter((c) => c.id !== 'reproduce:dams')];
	const dams = done.filter((d): d is { part: BundleDamPart; result: BundlePartResult } => d.part.kind === 'dam');
	const reliability = fromParts.find((c) => c.id === 'reproduce:dams') ?? null;
	if (dams.length || reliability) checks.push(await foldDams(bytes, opts, dams, reliability));
	checks.sort((a, b) => rank(a.id) - rank(b.id));
	return { ...planned, checks, ok: checks.length > 0 && checks.every((c) => c.ok) };
}

async function foldDams(bytes: Uint8Array<ArrayBuffer>, opts: Opts, done: readonly { part: BundleDamPart; result: BundlePartResult }[], reliability: BundleCheck | null): Promise<BundleCheck> {
	let ctx: BundleAssessmentContext | null = null;
	await checkPackBundle(bytes, { ...opts, rerun: false, onAssessment: (c) => (ctx = c) });
	if (!ctx) return { id: 'reproduce:dams', ok: false, detail: "not re-run: the combined row's assessment failed a check" };
	const c: BundleAssessmentContext = ctx;
	const problems: string[] = [];
	if (!reliability) problems.push("the assurance of supply wasn't re-run (the combined row's part has no result)");
	else if (!reliability.ok) problems.push(reliability.detail);
	for (const d of done) if (d.result.checks.some((k) => !k.ok)) problems.push(...d.result.checks.filter((k) => !k.ok).map((k) => k.detail));
	const ids = c.report.dams?.nodeIds ?? [];
	const members = c.file.members;
	const yieldOf = (damPosition: number, run: BundleDamPart['run'], memberPosition: number | null) =>
		done.find((d) => d.part.damPosition === damPosition && d.part.run === run && d.part.memberPosition === memberPosition)?.result.damYield?.yieldM3Year ?? null;
	const fresh: CumulativeRow[] = ids.map((nodeId, i) => {
		const dam: CumulativeDam = { nodeId, name: damName(c.report.rows, nodeId) };
		return cumulativeDamRow('dam_firm_yield', dam, yieldOf(i, 'baseline', null), members.map((_, j) => yieldOf(i, 'single', j)), yieldOf(i, 'combined', null));
	});
	const stored = c.report.rows.filter((r) => r.metric === 'dam_firm_yield');
	const differs = rowDifferences(stored, fresh);
	const engineNote = c.file.engineVersion && c.file.engineVersion !== ENGINE_VERSION ? ` The assessment ran on engine ${c.file.engineVersion}; this is ${ENGINE_VERSION}: check out that engine (README.md).` : '';
	if (differs.length) problems.push(`re-run with engine ${ENGINE_VERSION}: ${differs.slice(0, 8).join('; ')}.${engineNote}`);
	const n = ids.length;
	return problems.length
		? { id: 'reproduce:dams', ok: false, detail: problems.join('; ') }
		: {
				id: 'reproduce:dams',
				ok: true,
				detail: `the firm yield (${done.length} search${done.length === 1 ? '' : 'es'}, each its own job) and assurance of supply of ${n === 1 ? 'the dam' : `each of the ${n} dams`} the applications touch, on every run, are the stored report's`
			};
}
