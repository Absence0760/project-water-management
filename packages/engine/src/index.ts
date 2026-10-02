// Public surface of the model engine. Keep this package free of I/O so the
// same code runs in the browser (live calibration) and in Lambda (saved runs).
export * from './calendar';
export * from './compare';
export * from './demand';
export * from './forecast';
export * from './format';
export * from './project';
export * from './manifest';
export * from './run';
export * from './warmstart/snapshot';
export { prepareRun, type PreparedRun } from './prepare';
export * from './version';
export * from './languages';
export * from './legal';
export * from './runoff';
export * from './calibrate/calibrate';
export * from './calibrate/site';
export * from './calibrate/representativeness';
export * from './calibrate/dayFlags';
export * from './calibrate/params';
export * from './calibrate/objective';
export * from './calibrate/objectives';
export * from './calibrate/bootstrap';
export * from './reference/wr2012';
export * from './reference/wr2012Fit';
export * from './reference/wr2012Settings';
export { resolveWr2012 } from './reference/wr2012Resolve';
export * from './reserve/rules';
export * from './reserve/assurance';
export * from './reserve/riverMeasures';
export * from './calibrate/provenance';
export * from './calibrate/rulesSettings';
export * from './calibrate/rules';
export * from './calibrate/auto';
export { dds, reflect, type Bounds, type DdsOptions, type DdsResult } from './calibrate/dds';
export { Rng } from './random';
export * from './quality';
export * from './rain';
export * from './rainSourcePeriods';
export * from './rainThreshold';
export * from './evaporation/fao56Table5';
export * from './evaporation/apanDaily';
export * from './evaporation/lakeFactorPresets';
export * from './accumulation';
export * from './doublemass';
export * from './plausibility';
export * from './recession';
export * from './uncertainty';
export * from './modelRules';
export * from './scenario';
export * from './verify/columns';
export { verifyRun } from './verify/verify';
export * from './verify/audit';
export { buildTopology, ewrSiteNodes, isEwrSite, type Topology } from './network/topology';
export { EWR_BINDING_SERIES } from './network/bindingSeries';
export { parseTransferRuleKey, TRANSFER_RULE_SERIES, transferRuleKey } from './network/transferSeries';
export { hasMonthlyRates, monthlyRatesMismatch, transferRatesM3s, validMonthlyRates, WATER_YEAR_MONTHS, withMonthlyRates } from './network/transferRates';
export { isRiverOfftake, OFFTAKE_SERIES, offtakeReturnAt } from './network/offtake';
export { BASIC_NEEDS_SERIES, basicNeedsM3Day, basicNeedsPopulation, DEMAND_OBJECT_SERIES, objectDemandKey, fromSupplyOrder, objectMonthlyM3Day, objectRank, objectSuppliedKey, parseDemandObjectKey, supplyLevels, supplyOrder } from './network/demandObjects';
export { CROPS_TAKE_KEY, RIVER_TAKE_SERIES, riverPoolEvaporationKey, riverPoolKey, riverPumpLimitedKey, riverTakeKey } from './network/riverSource';
export { demandBySource, demandSourceShares, type DemandSourceShare } from './network/demandSources';
export { DEMAND_SCHEDULE_MAX_EASTER_OFFSET, DEMAND_SCHEDULE_MAX_FACTOR, DEMAND_SCHEDULE_MAX_WINDOWS, easterSunday, isoWeekday, scheduleFactors, scheduleWindowProblem } from './network/demandSchedule';
export {
	DEMAND_PART_WORDS,
	describeDroughtRestriction,
	describeRestrictionLevel,
	droughtRestrictionChanges,
	droughtRestrictionIssues,
	droughtRestrictionNodeIssues,
	levelCut,
	monthDayText,
	parseMonthDay,
	resolveDroughtRestriction,
	restrictedObjectDemand,
	restrictionCutKey,
	restrictionLevelFor,
	restrictionRuleFromNotice,
	RESTRICTION_DATES_MAX,
	RESTRICTION_NODES_MAX,
	RESTRICTION_LABEL_MAX,
	RESTRICTION_LEVELS_MAX,
	RESTRICTION_SERIES,
	RESTRICTION_SOURCE_MAX,
	type RestrictionIssue
} from './network/restriction';
export { curveAreaAt, resolveDamCurve, type DamCurve } from './network/dam';
export { DAM_AGO_DAYS, DAM_YEAR_DAYS, damFigures, type DamFigures } from './network/damLevel';
export { abstractionStartDay, capacityScaleOf, DAM_CAPACITY_SERIES, DAM_SEDIMENT_MAX_PER_YEAR, damCapacityFactor, damCapacityOn, developmentProblem, SEDIMENT_YEAR_DAYS } from './network/development';
export { DAM_CURVE_CAPACITY_TOLERANCE, damCurveProblem } from './network/damCurve';
export { flowShares, inputFlowShares, overAllocationError, SHARE_TOLERANCE, type FlowShares } from './network/shares';
export { calibrationStats, type CalibrationWindow } from './network/stats';
export { ewrCompliance, type EwrCountMethod, type EwrSite } from './network/ewr';
export { belowEwr, ewrAgreement, scoreContingency, type EwrAgreementExclusion, type EwrAgreementOptions } from './network/ewrAgreement';
export * from './network/yield';
export { computeCurtailment, DEMAND_PCT_FLOOR_M3_DAY, demandPctNote, EQUITABLE_SHARE_FOOTNOTE, M3_PER_DAY_PER_LS, type CurtailmentInput, type ReportWindow } from './network/curtailment';
export {
	DEFAULT_ANNUAL_THRESHOLD,
	STRESS_LABEL,
	STRESS_THRESHOLDS,
	stressClassOf,
	supplyAssurance,
	type ReliabilityMonth,
	type StressClass,
	type StressGrid,
	type StressSummary,
	type SupplyAssurance,
	type SupplyReliability,
	type WaterAccount,
	type WaterAccountEwr,
	type WaterAccountRow
} from './network/reliability';
export * from './views/farmView';
export * from './views/notice';
export * from './views/farmProjection';
export * from './views/farmOutlook';
export * from './views/fdc';
export * from './views/yearClasses';
export * from './views/outcomeMatrix';
export * from './views/licenceImpact';
export * from './views/reserveYears';
export * from './outlook';
export * from './outlook/triggers';
export * from './units';
export * from './seriesProvenance';
export * from './liability';
export * from './evidence';
export * from './allocations/compare';
export * from './allocations/mode';
export * from './flowGapFill';
