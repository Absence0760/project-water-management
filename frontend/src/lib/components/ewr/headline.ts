// Which EWR test the results are judged by (settings.ewrHeadline, issue #444;
// backend projects/ewrHeadlineSettings.ts, docs/ui.md § Settings → Judge
// results by): the choices Settings offers, what each is called, and whether a
// stored choice still has its rule table. runs/ewrAssurance.ts resolveHeadline
// applies the choice to a run.
import type { EwrAssuranceSite, EwrRuleTable, NetworkNode } from '@water-management/engine';
import type { EwrHeadline } from '$lib/api/types';

export const HEADLINE_AUTO: EwrHeadline = Object.freeze({ source: 'auto' });

type Node = Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId' | 'sortOrder'>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** settings.ewrHeadline, or `auto` when absent (an older API) or not a choice. A fresh object: the form edits it. */
export function resolveEwrHeadline(settings: { ewrHeadline?: unknown } | null | undefined): EwrHeadline {
	const h = settings?.ewrHeadline;
	if (!isObj(h)) return { source: 'auto' };
	if (h.source === 'pragmatic') return { source: 'pragmatic' };
	if (h.source === 'ruleTable' && (h.siteNodeId === null || typeof h.siteNodeId === 'string')) return { source: 'ruleTable', siteNodeId: h.siteNodeId };
	return { source: 'auto' };
}

/** One option's value in a <select>: "auto", "pragmatic", "table:outlet" or "table:<node id>". */
export function headlineKey(h: EwrHeadline): string {
	return h.source === 'ruleTable' ? `table:${h.siteNodeId ?? 'outlet'}` : h.source;
}

/** The choice an option's value stands for (headlineKey's inverse). */
export function headlineOfKey(key: string): EwrHeadline {
	if (key === 'pragmatic') return { source: 'pragmatic' };
	if (key.startsWith('table:')) {
		const id = key.slice('table:'.length);
		return { source: 'ruleTable', siteNodeId: id === 'outlet' ? null : id };
	}
	return { source: 'auto' };
}

/**
 * The rule-table sites as the headline names them, the outlet first, then
 * the gauges in network order: a table keyed null or by the outlet's own id
 * is the outlet (siteNodeId null). A table whose gauge has gone is left out:
 * no run can report it.
 */
export function ruleTableSites(nodes: readonly Node[], ewrRules: readonly Pick<EwrRuleTable, 'siteNodeId'>[]): { siteNodeId: string | null; label: string }[] {
	const outlet = nodes.find((n) => n.downstreamNodeId === null);
	const keys = new Set(ewrRules.map((t) => (t.siteNodeId === null || t.siteNodeId === outlet?.id ? null : t.siteNodeId)));
	const out: { siteNodeId: string | null; label: string }[] = [];
	if (keys.has(null)) out.push({ siteNodeId: null, label: outlet ? `the outlet, ${outlet.name}` : 'the outlet' });
	const gauges = nodes.filter((n) => n.kind === 'gauge' && n !== outlet && keys.has(n.id)).sort((a, b) => a.sortOrder - b.sortOrder);
	for (const g of gauges) out.push({ siteNodeId: g.id, label: g.name });
	return out;
}

/** The pragmatic EWR is set: some month above 0 (otherwise "never below it" says nothing). */
export const pragmaticSet = (ewr: readonly number[]) => ewr.some((v) => v > 0);

/** What `auto` judges by today, in words, from the tables as they are (the order resolveHeadline follows). */
export function autoText(sites: readonly { siteNodeId: string | null; label: string }[]): string {
	const first = sites.find((s) => s.siteNodeId === null) ?? sites[0];
	return first ? `the Reserve rule table at ${first.label}` : 'the pragmatic EWR at the outflow gauge';
}

export interface HeadlineOption {
	key: string;
	label: string;
}

/**
 * Settings' choices: Automatic (saying what it picks now), the pragmatic EWR
 * when it is set, and each site with a rule table. A stored choice that is no
 * longer on offer (its table gone, the pragmatic EWR cleared) keeps an option
 * so the select shows it, labelled as such; headlineProblem says why.
 */
export function headlineOptions(nodes: readonly Node[], ewrRules: readonly Pick<EwrRuleTable, 'siteNodeId'>[], ewr: readonly number[], current: EwrHeadline): HeadlineOption[] {
	const sites = ruleTableSites(nodes, ewrRules);
	const out: HeadlineOption[] = [{ key: 'auto', label: `Automatic: now ${autoText(sites)}` }];
	if (pragmaticSet(ewr) || current.source === 'pragmatic') out.push({ key: 'pragmatic', label: 'The pragmatic EWR at the outflow gauge' });
	for (const s of sites) out.push({ key: headlineKey({ source: 'ruleTable', siteNodeId: s.siteNodeId }), label: `The Reserve rule table at ${s.label}` });
	const key = headlineKey(current);
	if (!out.some((o) => o.key === key)) out.push({ key, label: 'A Reserve rule table no longer in the settings' });
	return out;
}

/**
 * The test a choice judges by as the settings stand: a rule table or the
 * pragmatic EWR (`auto` is a rule table whenever there is one), for the hint
 * when the daily charge (settings.ewrChargeSource) follows the other.
 */
export function headlineTest(h: EwrHeadline, nodes: readonly Node[], ewrRules: readonly Pick<EwrRuleTable, 'siteNodeId'>[]): 'pragmatic' | 'ruleTable' {
	const sites = ruleTableSites(nodes, ewrRules);
	if (h.source === 'pragmatic') return 'pragmatic';
	if (h.source === 'ruleTable' && sites.some((s) => s.siteNodeId === h.siteNodeId)) return 'ruleTable';
	return sites.length ? 'ruleTable' : 'pragmatic';
}

/**
 * Why the choice can't be followed as the settings stand, or null: a rule
 * table that has gone (results then fall back to Automatic), or a pragmatic
 * EWR of 0 in every month.
 */
export function headlineProblem(h: EwrHeadline, nodes: readonly Node[], ewrRules: readonly Pick<EwrRuleTable, 'siteNodeId'>[], ewr: readonly number[]): string | null {
	if (h.source === 'pragmatic') return pragmaticSet(ewr) ? null : 'The pragmatic EWR is 0 in every month, so every day meets it.';
	if (h.source !== 'ruleTable') return null;
	if (ruleTableSites(nodes, ewrRules).some((s) => s.siteNodeId === h.siteNodeId)) return null;
	return 'That site has no Reserve rule table any more, so results are judged automatically until you choose again.';
}

/**
 * What a run is judged by, in words, for River & reserve's line: resolved
 * from the run itself (runs/ewrAssurance.ts resolveHeadline), so it names the
 * table the cards read, with "(automatic)" when the project hasn't chosen.
 */
export function judgedByText(site: Pick<EwrAssuranceSite, 'isOutlet' | 'name'> | null, choice: EwrHeadline | null | undefined): string {
	const what = site ? `the Reserve rule table at ${site.isOutlet ? `the outlet, ${site.name}` : site.name}` : 'the pragmatic EWR at the outflow gauge';
	return !choice || choice.source === 'auto' ? `${what} (automatic)` : what;
}

/**
 * The printed report's line under its lede (issue #444): what the run is
 * judged by and that it is the project's setting at printing. The choice is
 * a lens over a run, not a model input, so a run printed again after the
 * setting changes is judged by the new one; this line keeps each printed copy
 * saying which. `fellBack`: the run has no table at the chosen site
 * (runs/ewrAssurance.ts resolveHeadline). '' when there is nothing to choose
 * between (no rule table in the run, the project automatic), as River &
 * reserve leaves its line out.
 */
export function reportJudgedBy(
	site: Pick<EwrAssuranceSite, 'isOutlet' | 'name'> | null,
	choice: EwrHeadline | null | undefined,
	fellBack: boolean,
	hasRuleTable: boolean
): string {
	if (!hasRuleTable && (!choice || choice.source === 'auto')) return '';
	const why = fellBack ? '; this run has no Reserve rule table at the chosen site, so it is judged automatically' : '';
	return `Results are judged by ${judgedByText(site, choice)}, the project’s setting when this report was printed${why}.`;
}

/**
 * The EWR compliance heat map's clause when the headline is a rule table
 * (site from resolveHeadline): its outlet cells count days below the
 * pragmatic EWR, which isn't what the results are judged by. '' when the
 * headline is the pragmatic EWR itself.
 */
export function heatmapHeadlineNote(site: Pick<EwrAssuranceSite, 'isOutlet' | 'name'> | null, choice: EwrHeadline | null | undefined): string {
	return site ? `These bands count days below the pragmatic EWR; the results are judged by ${judgedByText(site, choice)} instead.` : '';
}
