// Public surface of the model engine. Keep this package free of I/O so the
// same code runs in the browser (live calibration) and in Lambda (saved runs).
export * from './calendar';
export * from './compare';
export * from './demand';
export * from './flow';
export * from './project';
export * from './run';
export * from './runoff';
export * from './calibrate/calibrate';
export * from './calibrate/objective';
export * from './reference/wr2012';
export * from './calibrate/provenance';
export { dds, reflect, type Bounds, type DdsOptions, type DdsResult } from './calibrate/dds';
export { Rng } from './random';
export * from './quality';
export * from './rain';
export * from './doublemass';
export * from './verify/columns';
export { verifyRun } from './verify/verify';
export { buildTopology, type Topology } from './network/topology';
export { flowShares, SHARE_TOLERANCE, type FlowShares } from './network/shares';
export { calibrationStats, waterYearOf, type CalibrationWindow } from './network/stats';
export { ewrCompliance, type EwrCountMethod, type EwrSite } from './network/ewr';
export { belowEwr, ewrAgreement, scoreContingency, type EwrAgreementExclusion, type EwrAgreementOptions } from './network/ewrAgreement';
export { computeCurtailment, DEMAND_PCT_FLOOR_M3_DAY, demandPctNote, EQUITABLE_SHARE_FOOTNOTE, M3_PER_DAY_PER_LS, type CurtailmentInput, type ReportWindow } from './network/curtailment';
