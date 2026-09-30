// The project list's outcomes (issue #17, docs/ui.md § Project list): which
// catchments need attention and why, in words, and the list's sort orders.
// The figures are the portfolio's (GET /projects/outcomes), worded by the
// portfolio's own helpers, so a catchment reads the same on both pages.
// Pure, so it is unit-tested apart from the page.
import type { PortfolioProject, ProjectSummary } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { ageText, comparePortfolio, type SortDir, curtailmentHref, ewrText, farmsShortText, feedsText } from '$lib/components/portfolio/portfolio';

export type Outcomes = ReadonlyMap<string, PortfolioProject>;

export interface Reason {
	/** What is wrong, in words ("Red: EWR not met 9 of 30 days"). */
	text: string;
	tone: 'danger' | 'warn';
	/** Where to look into it, when there is one place. */
	href?: string;
}

export interface Attention {
	/** Higher is more urgent; 0 = nothing needs attention. */
	score: number;
	/** Worst first. */
	reasons: Reason[];
}

const NONE: Attention = { score: 0, reasons: [] };

/**
 * What needs attention in one catchment, worst first: a red EWR, units short
 * in the figures' last week, alerts firing, an amber EWR, failing feeds, newer
 * rain than the figures, figures over STALE_DAYS ($lib/format/age) old (the portfolio's "stale"). A catchment
 * without figures (not run, or a role that gets none) needs nothing here.
 */
export function attention(o: PortfolioProject | undefined, base = ''): Attention {
	if (!o) return NONE;
	const out: (Reason & { score: number })[] = [];
	if (o.ewr.status === 'red') out.push({ score: 100 + (o.ewr.fraction30 ?? 0) * 10, text: ewrText(o), tone: 'danger' });
	if (o.farmsShort7 && o.sourceRunId)
		out.push({ score: 50 + Math.min(o.farmsShort7, 40), text: farmsShortText(o)!, tone: 'danger', href: curtailmentHref(o, base) });
	if (o.alertsFiring > 0) out.push({ score: 40, text: `${fmtNum(o.alertsFiring)} alert${o.alertsFiring === 1 ? '' : 's'} firing`, tone: 'warn' });
	if (o.ewr.status === 'amber') out.push({ score: 30 + (o.ewr.fraction30 ?? 0) * 10, text: ewrText(o), tone: 'warn' });
	if (o.feeds.failing > 0) out.push({ score: 20, text: feedsText(o), tone: 'warn' });
	if (o.behindData) out.push({ score: 10, text: 'Newer rain not in the figures', tone: 'warn' });
	if (o.stale && o.figuresUntil && o.figuresAgeDays != null)
		out.push({ score: 5, text: `Figures ${ageText(o)}`, tone: 'warn' });
	if (!out.length) return NONE;
	out.sort((a, b) => b.score - a.score);
	return { score: out.reduce((n, r) => n + r.score, 0), reasons: out.map(({ score: _s, ...r }) => r) };
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export interface Flagged {
	project: ProjectSummary;
	attention: Attention;
}

/** The catchments that need attention, most urgent first (ties by name). */
export function needsAttention(projects: readonly ProjectSummary[], outcomes: Outcomes, base = ''): Flagged[] {
	return projects
		.map((project) => ({ project, attention: attention(outcomes.get(project.id), base) }))
		.filter((f) => f.attention.score > 0)
		.sort((a, b) => b.attention.score - a.attention.score || collator.compare(a.project.name, b.project.name));
}

/** A key the list sorts by from the figures (the old team portfolio's keys among them). */
export type OutcomeSortKey = 'attention' | 'status' | 'farms' | 'dam' | 'age' | 'run';

/**
 * Sort by an outcome. Rows without figures (still loading, or none for the
 * role) go last, by name, and so do unknown values, in either direction.
 * `asc` (the default) is worst or newest first; `desc` turns it round.
 */
export function sortByOutcome(projects: readonly ProjectSummary[], key: OutcomeSortKey, outcomes: Outcomes, dir: SortDir = 'asc'): ProjectSummary[] {
	const byName = (a: ProjectSummary, b: ProjectSummary) => collator.compare(a.name, b.name);
	const sign = dir === 'asc' ? 1 : -1;
	const out = [...projects];
	if (key === 'run') {
		const t = (p: ProjectSummary) => (p.lastRunAt ? Date.parse(p.lastRunAt) : null);
		return out.sort((a, b) => {
			const ta = t(a);
			const tb = t(b);
			if (ta === null || tb === null) return ta === tb ? byName(a, b) : ta === null ? 1 : -1;
			return sign * (tb - ta) || byName(a, b);
		});
	}
	if (key === 'attention') {
		const s = (p: ProjectSummary) => attention(outcomes.get(p.id)).score;
		const has = (p: ProjectSummary) => (outcomes.has(p.id) ? 0 : 1);
		return out.sort((a, b) => has(a) - has(b) || sign * (s(b) - s(a)) || byName(a, b));
	}
	const cmp = comparePortfolio({ key, dir });
	return out.sort((a, b) => {
		const oa = outcomes.get(a.id);
		const ob = outcomes.get(b.id);
		if (!oa || !ob) return oa === ob ? byName(a, b) : oa ? -1 : 1;
		return cmp(oa, ob);
	});
}
