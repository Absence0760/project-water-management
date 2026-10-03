// The glossary's articles for the "Scenarios and licensing" topic (category
// 'licensing' in tips.ts): scenarios, the published baseline, licence
// applications and evidence packs. Same shape and rules as articles.ts, in
// the tips' order. A module of its own, like articles-data.ts, so the /help
// pages load the glossary's long text in chunks each under the bundle guard's
// per-chunk ceiling (vite.config.ts helpArticlesChunk); content.ts joins them.

import type { HelpArticle } from './types';

export const LICENSING_ARTICLES: Record<string, HelpArticle> = {
	// ---- Scenarios and licensing -------------------------------------------
	'published-baseline': {
		long: 'An editor publishes a run from Runs & results with **Publish this run**, with the catchment’s restriction notice. It is what people outside the model read: farmers see their own farm’s figures from it, share links show it, and an applicant’s application starts from it. Publishing another run replaces it; the earlier publications stay on record. With nothing published, farmers see no figures and an applicant can’t start an application.',
		aliases: ['baseline', 'publication', 'publish', 'published run', 'restriction notice'],
		related: ['run', 'application', 'roles'],
		source: 'docs/data-model.md § Published baseline; docs/design/farmer-view.md'
	},
	'scenario': {
		long: 'A scenario is a named, ordered list of changes on a base run: raise a dam by 20 %, replace a crop, remove a farm, add a transfer, scale the rain by −10 %. It runs and compares against its base without copying the project, and because it keeps the base’s ids every change lines up in Compare runs. Editors make scenarios on the Scenarios tab to explore; a licence application is a scenario an applicant makes on the published baseline.',
		aliases: ['what-if', 'override', 'overrides', 'base run'],
		related: ['run', 'application'],
		source: 'docs/scenarios.md'
	},
	'application': {
		long: 'Someone applying for a water-use licence (a developer, an agribusiness or their consultant) is added to the project with the **Applicant** role. They never see the model itself: they start an application on the published baseline, describe their proposed change as a scenario (a new or raised dam, a new abstraction, more land under irrigation), run it and see their results against the baseline: the Ecological Reserve, the catchment’s flow, their own hydrological units and the farms downstream. Other farms show only by an anonymous name.\n\nWhile it is a draft only the applicant and the people they share it with can see it. Once they **submit** it, its changes are frozen and it appears on the **Applications** tab, where the project’s owners and editors (the assessors) open it, read its runs and record a decision with reasons. The applicant can withdraw it, or reopen it as a draft. The assessors issue its evidence packs, and can **Assess together** several applications for their cumulative effect on the river.',
		aliases: ['applications', 'licence application', 'water-use licence', 'WULA', 'applicant', 'assessor', 'contributor', 'submit', 'decision'],
		related: ['scenario', 'published-baseline', 'evidence-pack', 'roles'],
		source: 'docs/ui.md § Applications (WP-3.3); docs/scenarios.md § Applications'
	},
	'evidence-pack': {
		long: 'An evidence pack is a run’s evidence report frozen as a hashed, versioned, signed document that stays the same once it is issued. An applicant attaches it to their water-use licence application, and anyone holding it can check it against the app with its short code on the public verify page. An editor drafts one from a run’s evidence report; it is signed, then issued, and can later be superseded by a new version or withdrawn.',
		aliases: ['pack', 'short code', 'verify', 'manifest', 'sign-off'],
		related: ['application', 'evidence-run'],
		source: 'docs/evidence-pack.md'
	},
};
