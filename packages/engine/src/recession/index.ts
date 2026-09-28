// Recession diagnostics (engine ≥ 1.19.0, docs/model.md §2.10d "Recession
// diagnostics"; calibration-research.md CR-13): segment extraction, −dQ/dt vs
// Q and the power-law fit, ported from TOSSH (Gnann et al. 2021).
export * from './analysis';
export * from './check';
export * from './segments';
