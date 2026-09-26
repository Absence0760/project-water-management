// Public surface of the model engine. Keep this package free of I/O so the
// same code runs in the browser (live calibration) and in Lambda (saved runs).
export * from './calendar';
export * from './compare';
export * from './demand';
export * from './flow';
export * from './forecast';
export * from './project';
export * from './manifest';
export * from './run';
export * from './runoff';
export * from './calibrate/calibrate';
export * from './calibrate/objective';
export * from './reference/wr2012';
export * from './reserve/rules';
export * from './reserve/assurance';
export * from './calibrate/provenance';
export { dds, reflect, type Bounds, type DdsOptions, type DdsResult } from './calibrate/dds';
export { Rng } from './random';
export * from './quality';
export * from './rain';
export * from './rainSourcePeriods';
export * from './evaporation/fao56Table5';
export * from './accumulation';
export * from './doublemass';
export * from './plausibility';
export * from './uncertainty';
export * from './modelRules';
export * from './scenario';
export * from './verify/columns';
export { verifyRun } from './verify/verify';
export { buildTopology, type Topology } from './network/topology';
export { curveAreaAt, DAM_CURVE_CAPACITY_TOLERANCE, damCurveProblem, resolveDamCurve, type DamCurve } from './network/dam';
export { flowShares, inputFlowShares, overAllocationError, SHARE_TOLERANCE, type FlowShares } from './network/shares';
export { calibrationStats, waterYearOf, type CalibrationWindow } from './network/stats';
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
export * from './views/farmProjection';
export * from './units';
export * from './seriesProvenance';
export * from './liability';
export * from './allocations/compare';
