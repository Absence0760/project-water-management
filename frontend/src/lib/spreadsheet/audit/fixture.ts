// Test fixture: a run of a random network (the engine's fuzz generator,
// synthetic) and the first farm with a dam the audit workbook can
// recompute, with what the API would return for it. Test-only.
import { farmAuditPlan, runModel, type AuditRun, type FarmAuditPlan, type ModelInput, type ModelOutput } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';

export interface AuditFixture {
	input: ModelInput;
	out: ModelOutput;
	nodeId: string;
	run: AuditRun;
	plan: FarmAuditPlan;
}

export function auditRunOf(input: ModelInput, out: ModelOutput, nodeId: string): AuditRun {
	const of = (id: string | null) => new Map(out.series.filter((s) => s.nodeId === id).map((s) => [s.key, s.values]));
	return {
		settings: input.settings,
		model: input.model,
		startDate: out.startDate,
		days: out.days,
		apanDailyDays: out.summary.apanDaily?.dailyDays ?? 0,
		farm: of(nodeId),
		catchment: of(null)
	};
}

export function auditFixture(): AuditFixture {
	for (let seed = 1; seed < 500; seed++) {
		const input = randomInput(seed, { maxDays: 400 });
		let out: ModelOutput | null = null;
		for (const n of input.model.nodes) {
			if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) continue;
			out ??= runModel(input);
			const run = auditRunOf(input, out, n.id);
			const r = farmAuditPlan(run, n.id);
			if ('plan' in r && out.days > 30) return { input, out, nodeId: n.id, run, plan: r.plan };
		}
	}
	throw new Error('no random network has a farm the audit workbook can recompute');
}
