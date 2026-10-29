// What each project setting is, for the assistant (issue #640): the rule that
// a calibrated parameter is never changed to make an outcome look better is
// kept here as data, not only as prompt prose. get_settings sends each
// setting's kind beside its value, and propose_settings refuses a change whose
// kind the proposal's goal doesn't allow (tools/proposeSettings.ts).
//
// - calibrated: fitted to the observed flow, or forcing that trades off
//   against the fit (GR4J's X1–X4, the calibration zones' own X1–X4 with
//   their windows and records, the pan coefficients and PE, the CHIRPS bias
//   factors and their fit). The model of nature: changed only to improve
//   the fit, as a recalibration.
// - input: the rest of the description of the catchment and its data (the
//   evaporation and rain inputs, the windows, the calibration site and
//   record, data checks and gap filling). Changed to improve the fit or to
//   correct a setup error, never to reach an outcome.
// - assessment: what the results are judged against (the EWR and the
//   Reserve's tables, the assurance threshold, the reporting window).
//   Changed only to correct a setup error, never to make the EWR or
//   assurance look met.
// - management: how water is managed (the drought restriction rule, what the
//   registered volumes do to a run). The settings an outcome goal may change,
//   beside the network's operating levers (proposeSettings.ts MANAGEMENT_*).
//
// Every key a settings save accepts (projects/settings.ts SettingsPatch) is
// either here or one the assistant never proposes (NOT_PROPOSED);
// proposeSettings.test.ts fails on a key in neither.

export const SETTING_KIND_NAMES = ['calibrated', 'input', 'assessment', 'management'] as const;
export type SettingKind = (typeof SETTING_KIND_NAMES)[number];

export const SETTING_KINDS: Readonly<Record<string, SettingKind>> = {
	// Calibrated: fitted to observed flow, or forcing that trades off against the fit (docs/model.md §2.4a, §2.4b).
	gr4j: 'calibrated',
	panCoefficient: 'calibrated',
	pe: 'calibrated',
	chirpsBiasCorrection: 'calibrated',
	chirpsFitPeriod: 'calibrated',
	chirpsQuantileMap: 'calibrated',
	// Each zone's X1–X4, fitted on its own gauge (§2.10n); its window and record ride in the same row, replaced whole.
	calibrationZones: 'calibrated',
	// Input: the catchment, its data and the windows.
	februaryDays: 'input',
	effectiveRainFraction: 'input',
	effectiveRainFractionMonthly: 'input',
	effectiveRainStoreMm: 'input',
	lakeEvapFactor: 'input',
	lakeEvapFactorMonthly: 'input',
	lakeEvapFactorSource: 'input',
	apanMm: 'input',
	runoffModel: 'input',
	panCoefficientSource: 'input',
	arealRain: 'input',
	unitRain: 'input',
	rainStations: 'input',
	gapRain: 'input',
	rainSource: 'input',
	zeroRainRuns: 'input',
	calibration: 'input',
	simulationStart: 'input',
	simulationEnd: 'input',
	calibrationStart: 'input',
	calibrationEnd: 'input',
	calibrationFlowKind: 'input',
	calibrationSiteNodeId: 'input',
	calibrationExclusions: 'input',
	flowMissing: 'input',
	flowGapFill: 'input',
	qualityFlags: 'input',
	dataQuality: 'input',
	wr2012: 'input',
	// Assessment: the yardstick the results are judged against.
	assuranceAnnualThreshold: 'assessment',
	allocationTolerance: 'assessment',
	ewrPragmaticM3PerDay: 'assessment',
	ewrRules: 'assessment',
	ewrChargeSource: 'assessment',
	lowFlowMeasure: 'assessment',
	ewrDailySource: 'assessment',
	reportStart: 'assessment',
	reportEnd: 'assessment',
	// Management: how the water is managed.
	droughtRestriction: 'management',
	allocationMode: 'management'
};

/** What a proposal is for (propose_settings' `goal`). */
export const PROPOSAL_GOALS = ['outcome', 'recalibration', 'correction'] as const;
export type ProposalGoal = (typeof PROPOSAL_GOALS)[number];

/**
 * The kinds of setting each goal may change. An outcome (the EWR, yield,
 * assurance, supply) only through management; a recalibration (the fit to
 * observed flow) through the calibrated parameters and the inputs; a
 * correction (a setup error the run shows) through the inputs and the
 * assessment settings. A calibrated parameter is a recalibration's only.
 */
export const GOAL_ALLOWS: Readonly<Record<ProposalGoal, readonly SettingKind[]>> = {
	outcome: ['management'],
	recalibration: ['calibrated', 'input'],
	correction: ['input', 'assessment']
};

/** Each goal in words, for the card's title and the tool's errors. */
export const GOAL_TITLE: Readonly<Record<ProposalGoal, string>> = {
	outcome: 'Management change',
	recalibration: 'Recalibration',
	correction: 'Correction'
};

/** Why a kind of setting may not serve a goal: the tool's error after the setting's key. */
export function kindRefusal(kind: SettingKind, goal: ProposalGoal): string {
	if (kind === 'calibrated')
		return goal === 'outcome'
			? 'a calibrated parameter (fitted to the observed flow) is never changed to improve an outcome: that tunes the model of the catchment to the answer wanted. Use a management lever (a dam’s runoff capture or release, a hands-off flow, a transfer rule, the drought restriction, demand) or say plainly that none exists. Change it only in a recalibration (goal "recalibration"), to improve the fit to observed flow'
			: 'a calibrated parameter changes only in a recalibration (goal "recalibration"), to improve the fit to observed flow';
	if (kind === 'input')
		return goal === 'outcome'
			? 'this describes the catchment or its data, not how water is managed, so it is never changed to improve an outcome. Use a management lever, or say plainly that none exists; propose it as a correction (goal "correction") only if the run shows it is wrong'
			: 'this is not changed in this kind of proposal';
	if (kind === 'assessment')
		return goal === 'outcome'
			? 'this is what the results are judged against (the EWR, the Reserve’s rules, the assurance threshold), so changing it to improve an outcome moves the goalposts. Use a management lever, or say plainly that none exists; propose it as a correction (goal "correction") only if the setup is wrong'
			: 'what the results are judged against changes only as a correction of the setup (goal "correction"), never to improve the fit';
	return 'a management setting is changed to improve an outcome (goal "outcome"); it is tried as a scenario on the run';
}
