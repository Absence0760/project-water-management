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
export { dds, reflect, type Bounds, type DdsOptions, type DdsResult } from './calibrate/dds';
export { Rng } from './random';
export * from './quality';
export { buildTopology, type Topology } from './network/topology';
export { flowShares, SHARE_TOLERANCE, type FlowShares } from './network/shares';
export { calibrationStats, moriasiRating, waterYearOf, type CalibrationWindow, type MoriasiRating } from './network/stats';
export { ewrCompliance, type EwrCountMethod, type EwrSite } from './network/ewr';
export { belowEwr, ewrAgreement, scoreContingency, type EwrAgreementExclusion, type EwrAgreementOptions } from './network/ewrAgreement';
export { computeCurtailment, M3_PER_DAY_PER_LS, type CurtailmentInput, type ReportWindow } from './network/curtailment';
