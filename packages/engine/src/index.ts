// Public surface of the model engine. Keep this package free of I/O so the
// same code runs in the browser (live calibration) and in Lambda (saved runs).
export * from './calendar';
export * from './demand';
export * from './flow';
export * from './project';
export * from './run';
export { buildTopology, type Topology } from './network/topology';
export { flowShares, SHARE_TOLERANCE, type FlowShares } from './network/shares';
export { calibrationStats } from './network/stats';
export { computeCurtailment, M3_PER_DAY_PER_LS, type CurtailmentInput, type ReportWindow } from './network/curtailment';
