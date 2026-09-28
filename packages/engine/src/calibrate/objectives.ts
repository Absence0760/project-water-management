// The objectives a fit can minimise, and their names. Apart from the scores
// themselves (./objective.ts), so the fit panel, run comparison and the
// uncertainty screens that name an objective don't load the scoring code
// (issue #9).

export const OBJECTIVES = ['kgePrime', 'kgeYearly', 'kgeNp', 'nseSqrt', 'nseLog', 'kgeLowHigh'] as const;
export type ObjectiveId = (typeof OBJECTIVES)[number];

export const OBJECTIVE_LABELS: Record<ObjectiveId, string> = {
	kgePrime: 'KGE′ (Kling–Gupta, 2012)',
	kgeYearly: 'Year-balanced KGE′ (mean over water years)',
	kgeNp: 'Non-parametric KGE',
	nseSqrt: 'NSE on √Q (medium flows)',
	nseLog: 'NSE on log Q (low flows)',
	kgeLowHigh: 'Mean of KGE′(Q) and KGE′(1/Q) (low and high flows)'
};
