// Which rules in a project move water for the EWR (issue #507): a dam's
// pass-inflow release, a unit's hands-off flow, a river off-take's hands-off
// flow and the drought restriction's EWR trigger. All four are off by default
// and no importer switches one on, so a baseline run keeps nothing in the
// river for the EWR unless someone has. This lists the ones a project has.
//
//   pnpm list:ewr-rules <project.json> [--json]
//
// The file is a project's Download project (JSON) (export.json, from the
// Project tab) or the workbook importer's project.json: both carry `model`
// and `settings`. No DB and no server, so it reads a production project
// only through the app's own export, as its member, never as the schema
// owner (CLAUDE.md rule 1; docs/run-locally.md § Which rules keep water for
// the EWR). Exit 0 whether or not any rule is on; 1 on a file it can't read.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ewrReleaseRules, type EwrReleaseRule, type EwrReleaseRulesInput } from '@water-management/engine';
import { cliPath } from './pan-sensitivity.js';

/** The rules switched on in a project document (export.json or project.json); throws on a file without a model. */
export function rulesOf(doc: unknown): EwrReleaseRule[] {
	const d = doc as Partial<EwrReleaseRulesInput> | null;
	if (!d || typeof d !== 'object' || !d.model || !Array.isArray(d.model.nodes))
		throw new Error('not a project document: no model.nodes (expected a Download project (JSON) export or the importer’s project.json)');
	return ewrReleaseRules({ model: { nodes: d.model.nodes, transfers: Array.isArray(d.model.transfers) ? d.model.transfers : [] }, settings: d.settings ?? null });
}

/** The report for people: one line per rule, or a line saying none is on. */
export function toText(rules: EwrReleaseRule[], file: string): string {
	if (!rules.length)
		return `${file}: no rule moves water for the EWR (no dam pass-inflow release, unit or off-take hands-off flow, or drought restriction EWR trigger is switched on); a run keeps nothing in the river for the EWR.\n`;
	const live = rules.filter((r) => !r.inert).length;
	const head = `${file}: ${rules.length} rule${rules.length === 1 ? '' : 's'} switched on, ${live} of ${rules.length} run${live === 1 ? 's' : ''} as stored:`;
	return [head, ...rules.map((r) => `- ${r.text}`), ''].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' } } });
	if (!positionals[0]) {
		console.error('usage: list:ewr-rules <project.json> [--json]');
		process.exit(1);
	}
	const file = cliPath(positionals[0]);
	readFile(file, 'utf8')
		.then((text) => {
			const rules = rulesOf(JSON.parse(text));
			process.stdout.write(values.json ? `${JSON.stringify(rules, null, 2)}\n` : toText(rules, positionals[0]!));
		})
		.catch((err: Error) => {
			console.error(`list:ewr-rules: ${err.message}`);
			process.exitCode = 1;
		});
}
