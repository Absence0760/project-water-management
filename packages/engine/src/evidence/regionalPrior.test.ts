// § 3's regional-prior line (evidence-22, issue #622): a fit that used the
// prior, the donors' medians started from it with no fit since, and nothing
// when the prior had no part (no record, parameters edited since, a fit
// applied after the start). Invented donors only.
import { describe, expect, it } from 'vitest';
import type { PriorProvenance, PriorStartRecord } from '../calibrate/prior';
import { evidenceRegionalPrior } from './regionalPrior';

const provenance = (over: Partial<PriorProvenance> = {}): PriorProvenance => ({
	dataset: 'synthetic',
	datasetVersion: 'synthetic 1',
	synthetic: true,
	donorSetSha256: 'ab'.repeat(32),
	donorSetHash: '0123456789abcdef',
	donorCount: 14,
	k: 7,
	similarityWeight: 0.5,
	donors: Array.from({ length: 7 }, (_, i) => ({ id: `SYN_0${i + 1}`, weight: 1 / 7 })),
	leaveOneOutSkill: 0.41,
	leaveOneOutN: 14,
	x1From: 'donors',
	referenceLoad: null,
	target: { zoneNodeId: null, units: null },
	...over
});
const RANGES = { x1: { p10: 300, p50: 400, p90: 600 }, x2: { p10: 0, p50: 0, p90: 0 }, x3: { p10: 50, p50: 70, p90: 90 }, x4: { p10: 1.2, p50: 1.6, p90: 2.1 } };
const start = (over: Partial<PriorStartRecord> = {}): PriorStartRecord => ({
	appliedAt: '2026-10-28T10:00:00.000Z',
	engineVersion: '1.106.0',
	params: { x1: 400, x2: 0, x3: 70, x4: 1.6 },
	ranges: RANGES,
	provenance: provenance(),
	...over
});

/** A fit record that used the prior, its fitted x1, x3, x4 as the settings below hold them unless edited. */
const fitRec = () => ({
	model: 'gr4j',
	free: ['x1', 'x3', 'x4'],
	params: { x1: 410, x2: 0, x3: 72, x4: 1.5 },
	fittedAt: '2026-10-28T11:00:00.000Z',
	editedParams: [],
	prior: { weight: 0.1, bounded: true, ranges: RANGES, provenance: provenance(), penaltyAtFit: 0.2, penaltyAtStart: 1 }
});

describe('evidenceRegionalPrior', () => {
	it('names a fit that used the prior, with the donor set and its skill', () => {
		const got = evidenceRegionalPrior({ settings: { gr4j: { x1: 410, x2: 0, x3: 72, x4: 1.5 }, fitRecord: fitRec() } });
		expect(got).toMatchObject({ kind: 'fit', donors: 7, donorCount: 14, weight: 0.1, bounded: true, noSkill: false, leaveOneOutSkill: 0.41 });
		expect(got!.text).toBe(
			'Parameters calibrated with the regional prior, 7 donors; penalty weight 0.1, search held to its p10–p90 box. Donor set “synthetic” (invented donors), 14 offered, SHA-256 abababababab…; leave-one-out skill 0.41.'
		);
	});

	it('names parameters started from the prior while they still hold its medians, and says when it has no skill', () => {
		const got = evidenceRegionalPrior({ settings: { gr4j: { x1: 400, x2: 0, x3: 70, x4: 1.6 }, gr4jPrior: [start({ provenance: provenance({ leaveOneOutSkill: -0.2 }) })], fitRecord: null } });
		expect(got).toMatchObject({ kind: 'start', weight: null, bounded: null, noSkill: true });
		expect(got!.text).toMatch(/^Parameters from the regional prior, 7 donors \(the donors’ medians, not calibrated\)\. .*leave-one-out skill -0\.20: the prior has no skill\.$/);
	});

	it('is null when the prior had no part in the parameters (positive control above)', () => {
		const at = { x1: 400, x2: 0, x3: 70, x4: 1.6 };
		expect(evidenceRegionalPrior({ settings: {} })).toBeNull();
		expect(evidenceRegionalPrior(undefined)).toBeNull();
		// Edited since the start.
		expect(evidenceRegionalPrior({ settings: { gr4j: { ...at, x1: 410 }, gr4jPrior: [start()] } })).toBeNull();
		// A fit without the prior applied after the start.
		expect(evidenceRegionalPrior({ settings: { gr4j: at, gr4jPrior: [start()], fitRecord: { fittedAt: '2026-10-28T12:00:00.000Z', editedParams: [] } } })).toBeNull();
		// A zone's start record only: not the catchment's parameters.
		expect(evidenceRegionalPrior({ settings: { gr4j: at, gr4jPrior: [start({ provenance: provenance({ target: { zoneNodeId: 'H', units: ['A'] } }) })] } })).toBeNull();
		// A start for the site's zone (one unit) once the zones are gone: the catchment is another target.
		expect(evidenceRegionalPrior({ settings: { gr4j: at, gr4jPrior: [start({ provenance: provenance({ target: { zoneNodeId: null, units: ['B'] } }) })] }, model: { nodes: [] } })).toBeNull();
		// A prior fit whose parameters were edited by hand since (recomputed from the snapshot, whatever the record says).
		expect(evidenceRegionalPrior({ settings: { gr4j: { x1: 999, x2: 0, x3: 72, x4: 1.5 }, fitRecord: fitRec() } })).toBeNull();
		// Positive control for the start above: the same record with no zone, on the catchment.
		expect(evidenceRegionalPrior({ settings: { gr4j: at, gr4jPrior: [start()] }, model: { nodes: [] } })?.kind).toBe('start');
	});
	it('says a prior with too few donors has an unknown skill, not none', () => {
		const got = evidenceRegionalPrior({ settings: { gr4j: { x1: 400, x2: 0, x3: 70, x4: 1.6 }, gr4jPrior: [start({ provenance: provenance({ leaveOneOutSkill: null }) })] } });
		expect(got).toMatchObject({ noSkill: false, leaveOneOutSkill: null });
		expect(got!.text).toMatch(/no leave-one-out score \(too few donors\), so its skill is unknown\.$/);
	});
});
