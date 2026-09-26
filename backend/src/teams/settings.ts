// A team's settings (055_team_settings; docs/api.md § Teams, docs/data-model.md
// § Teams). One key so far: the portfolio's traffic-light thresholds (roadmap
// WP-2.14, decision D11). The 055 CHECK holds the same shape in the database.
// Pure, so it is unit-tested apart from the routes.
import { z } from 'zod';
import { EWR_THRESHOLDS, type EwrThresholds } from '../portfolio/status.js';

const Pct = z.number().finite().min(0).max(100);

/** Green and amber cut-offs, percent of the 30 days with the outlet EWR not met: 0–100, green below amber. */
export const PortfolioThresholds = z
	.object({ green: Pct, amber: Pct })
	.strict()
	.refine((t) => t.green < t.amber, { message: 'the green cut-off must be below the amber one', path: ['green'] });

/** The stored document: `{ portfolio?: { thresholds?: { green, amber } } }`. Unknown keys are rejected. */
export const TeamSettings = z
	.object({ portfolio: z.object({ thresholds: PortfolioThresholds.optional() }).strict().optional() })
	.strict();
export type TeamSettings = z.infer<typeof TeamSettings>;

/** A change, in PATCH /teams/:id: `thresholds: null` goes back to the defaults. */
export const TeamSettingsPatch = z.object({ portfolio: z.object({ thresholds: PortfolioThresholds.nullable() }).strict() }).strict();
export type TeamSettingsPatch = z.infer<typeof TeamSettingsPatch>;

/** The thresholds that apply, and whether they are the team's own or the defaults. */
export interface AppliedThresholds extends EwrThresholds {
	source: 'team' | 'default';
}

/** The team's own thresholds, or null when it has set none (or the document doesn't parse: the defaults, never a guess). */
export function teamThresholds(settings: unknown): EwrThresholds | null {
	const parsed = TeamSettings.safeParse(settings ?? {});
	const t = parsed.success ? parsed.data.portfolio?.thresholds : undefined;
	return t ? { green: t.green, amber: t.amber } : null;
}

/** What the portfolio judges by: the team's thresholds, or the defaults (5 %, 20 %). */
export function appliedThresholds(settings: unknown): AppliedThresholds {
	const t = teamThresholds(settings);
	return t ? { ...t, source: 'team' } : { ...EWR_THRESHOLDS, source: 'default' };
}

/** The settings after a change: thresholds set, or removed (null). An empty portfolio section is dropped. */
export function applySettingsPatch(current: unknown, patch: TeamSettingsPatch): TeamSettings {
	const parsed = TeamSettings.safeParse(current ?? {});
	const next: TeamSettings = structuredClone(parsed.success ? parsed.data : {});
	const { thresholds } = patch.portfolio;
	const portfolio = { ...next.portfolio };
	if (thresholds) portfolio.thresholds = { green: thresholds.green, amber: thresholds.amber };
	else delete portfolio.thresholds;
	if (Object.keys(portfolio).length) next.portfolio = portfolio;
	else delete next.portfolio;
	return next;
}
