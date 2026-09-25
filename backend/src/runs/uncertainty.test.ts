import type { EnsembleHeader, MemberResult, RecordCoverage, ResolvedEnsembleOptions } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { coverageMismatch } from './uncertainty.js';

const options = { minMembers: 30, coverageWarning: 0.7 } as ResolvedEnsembleOptions;
const header = { records: [{ record: 'flow_observed_m3s', acceptanceDays: 400, heldOutDays: 200 }] } as EnsembleHeader;
const members = (kept: number) => Array.from({ length: 40 }, (_, i) => ({ accepted: i < kept })) as MemberResult[];
const row = (over: Partial<RecordCoverage>): RecordCoverage => ({ record: 'flow_observed_m3s', heldOutDays: 200, inside: 150, fraction: 0.75, warning: false, ...over });

describe('coverageMismatch: what the server can check of a posted coverage row', () => {
	it('accepts a consistent row, with and without the warning', () => {
		expect(coverageMismatch(options, header, members(35), [row({})])).toBeNull();
		expect(coverageMismatch(options, header, members(35), [row({ inside: 100, fraction: 0.5, warning: true })])).toBeNull();
	});
	it('needs the header’s records with their held-out days', () => {
		expect(coverageMismatch(options, header, members(35), [])).toMatch(/0 coverage rows, expected 1/);
		expect(coverageMismatch(options, header, members(35), [row({ record: 'flow_logger_m3s' })])).toMatch(/is not the flow_observed_m3s/);
		expect(coverageMismatch(options, header, members(35), [row({ heldOutDays: 201 })])).toMatch(/200 held-out days/);
	});
	it('withholds coverage below 30 kept members, and only then', () => {
		expect(coverageMismatch(options, header, members(29), [row({ inside: null, fraction: null })])).toBeNull();
		expect(coverageMismatch(options, header, members(29), [row({})])).toMatch(/must be withheld/);
		expect(coverageMismatch(options, header, members(30), [row({ inside: null, fraction: null })])).toMatch(/is missing/);
		expect(coverageMismatch(options, header, members(29), [row({ inside: null, fraction: null, warning: true })])).toMatch(/warns without a band/);
	});
	it('refuses counts that disagree with each other or the warning', () => {
		expect(coverageMismatch(options, header, members(35), [row({ inside: 201, fraction: 1.005 })])).toMatch(/inconsistent/);
		expect(coverageMismatch(options, header, members(35), [row({ fraction: 0.8 })])).toMatch(/inconsistent/);
		expect(coverageMismatch(options, header, members(35), [row({ warning: true })])).toMatch(/wrong warning/);
	});
});
