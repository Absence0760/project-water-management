// The small status tags on a runs-list row, and what each means (#586 D18). A row's tag
// keeps its run-specific detail as a hover title; the rail's "What the tags mean"
// key under the list says the same in words a touch or keyboard user can reach.
import type { RunMeta } from '#lib/api/index.js';
import { fmtDay } from '#lib/format/number.js';

export type RunTagId = 'latest' | 'auto' | 'forecast' | 'published' | 'evidence' | 'formerEvidence' | 'pinned' | 'scenario' | 'scenarioBase' | 'alternative' | 'noInputs' | 'signedOff' | 'errata' | 'legacy';

export interface RunTag {
	id: RunTagId;
	label: string;
	tone: 'plain' | 'owner' | 'warn';
	/** This run's own detail (which scenarios, which bugs), as the tag's hover title; null when the key says it all. */
	detail: string | null;
}

/** What each tag means, in the key's order (the rows' order too). */
export const TAG_MEANINGS: Record<RunTagId, string> = {
	latest: 'The newest run.',
	auto: 'Made automatically after new data arrived (Model settings → Automatic runs). Only the newest automatic run is kept, unless it is pinned or published.',
	forecast: 'A forecast run: the days after the last recorded rain run on forecast rain and are shown apart; its other figures cover the record before them. Only the newest forecast run is kept, unless it is pinned or published.',
	published: 'The published baseline: stakeholders and farmers see this run’s figures. Kept while a publication holds it.',
	evidence: 'The project’s nominated evidence run. Kept for good: it can’t be deleted.',
	formerEvidence: 'Nominated as evidence before, since replaced or withdrawn. Kept for good: it can’t be deleted.',
	pinned: 'Pinned: newer runs never push it out, and it can’t be deleted until it is unpinned.',
	scenario: 'Made by a scenario: its changes applied to its base run.',
	scenarioBase: 'The base of a scenario: kept for good while the scenario exists, so it can’t be deleted or unpinned.',
	alternative: 'A mitigation alternative a submitted scenario cites (Application details → Alternatives): kept with it, so it can’t be deleted.',
	noInputs: 'Made before runs stored their input series, so it can’t be re-run from them, only compared by hash.',
	signedOff: 'Signed off (see its report). Kept for good: it can’t be deleted.',
	errata: 'May be affected by a known engine bug, which changes results only under its conditions. See the run’s validation statement, and re-run on the current engine to compare.',
	legacy: 'Legacy runoff model (the original workbook’s, removed in engine 1.0.0): it does not conserve water at the event scale (audit H1). Workbook comparison only, not evidence; it can’t be re-run.'
};

const quoted = (names: readonly string[]) => names.map((n) => `“${n}”`).join(', ');

/** A row's tags in display order. */
export function runTags(
	r: Pick<RunMeta, 'id' | 'trigger' | 'forecastFrom' | 'scenarioName' | 'citedBy' | 'reproducible' | 'errata' | 'legacy' | 'pinned'>,
	ctx: { latestId: string | null; publishedId: string | null; evidence: 'current' | 'past' | undefined }
): RunTag[] {
	const tags: RunTag[] = [];
	const add = (id: RunTagId, label: string, tone: RunTag['tone'] = 'plain', detail: string | null = null) => tags.push({ id, label, tone, detail });
	const bases = (r.citedBy ?? []).filter((c) => c.kind === 'scenario').map((c) => c.name);
	const signers = (r.citedBy ?? []).filter((c) => c.kind === 'signoff').map((c) => c.name);
	const citing = (r.citedBy ?? []).filter((c) => c.kind === 'alternative').map((c) => c.name);
	if (r.id === ctx.latestId) add('latest', 'latest');
	if (r.trigger === 'auto') add('auto', 'Auto');
	if (r.trigger === 'forecast') add('forecast', 'Forecast', 'warn', r.forecastFrom ? `Forecast days from ${fmtDay(r.forecastFrom)}.` : null);
	if (r.id === ctx.publishedId) add('published', 'Published', 'owner');
	if (ctx.evidence === 'current') add('evidence', 'Evidence', 'owner');
	else if (ctx.evidence === 'past') add('formerEvidence', 'Former evidence');
	if (r.pinned) add('pinned', 'Pinned');
	if (r.scenarioName) add('scenario', 'Scenario', 'plain', `Made by the scenario “${r.scenarioName}”.`);
	if (bases.length) add('scenarioBase', 'Scenario base', 'plain', `The base of ${quoted(bases)}.`);
	if (citing.length) add('alternative', 'Alternative', 'plain', `A mitigation alternative of ${quoted(citing)}.`);
	if (r.reproducible === false) add('noInputs', 'Can’t be re-run');
	if (signers.length) add('signedOff', 'Signed off', 'owner', `Signed off by ${signers.join(', ')}.`);
	if (r.errata?.length) add('errata', 'May be affected', 'warn', `${r.errata.length === 1 ? 'A known engine bug' : `${r.errata.length} known engine bugs`}: ${r.errata.join(', ')}.`);
	if (r.legacy) add('legacy', 'Workbook comparison', 'warn');
	return tags;
}

/** The key's lines: each tag some shown row carries, once, in TAG_MEANINGS' order. */
export function tagKey(rows: readonly RunTag[][]): { label: string; meaning: string }[] {
	const seen = new Map<RunTagId, string>();
	for (const tags of rows) for (const t of tags) if (!seen.has(t.id)) seen.set(t.id, t.label);
	return (Object.keys(TAG_MEANINGS) as RunTagId[]).filter((id) => seen.has(id)).map((id) => ({ label: seen.get(id)!, meaning: TAG_MEANINGS[id] }));
}
