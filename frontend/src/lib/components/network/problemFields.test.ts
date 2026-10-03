import { describe, expect, it } from 'vitest';
import { newNetworkNode, type NetworkNode } from '@water-management/engine';
import { developmentIssue, supplyIssues } from '$lib/model/validate';
import { developmentProblemFields, supplyProblemFields } from './problemFields';

const node = (over: Partial<NetworkNode>): NetworkNode => ({ ...newNetworkNode('n', 1, 'out'), kind: 'farm', ...over });

describe('supplyProblemFields', () => {
	it('ties each supply message from the model check to its fields', () => {
		const [levels] = supplyIssues(node({ damCapacityM3: 1000, supplyRule: 'trigger', supplyTriggerPct: 0.5, supplyStopPct: 0.2 }));
		expect(supplyProblemFields(levels!)).toEqual(['levels']);
		const [rule] = supplyIssues(node({ damCapacityM3: 0, supplyRule: 'trigger' }));
		expect(supplyProblemFields(rule!)).toEqual(['rule']);
		const [ror] = supplyIssues(node({ damCapacityM3: 1000, supplyRule: 'runOfRiver' }));
		expect(supplyProblemFields(ror!)).toEqual(['rule']);
		const [pump] = supplyIssues(node({ supplyRule: 'riverFirst', pumpCapacityM3Day: -1 }));
		expect(supplyProblemFields(pump!)).toEqual(['pump']);
	});
});

describe('developmentProblemFields', () => {
	it('ties each development message from the model check to its fields', () => {
		expect(developmentProblemFields(null)).toEqual([]);
		expect(developmentProblemFields(developmentIssue(node({ damSedimentPctPerYear: 0.01, damSurveyDate: null })))).toEqual(['survey', 'sediment']);
		expect(developmentProblemFields(developmentIssue(node({ damSedimentPctPerYear: 0.5 })))).toEqual(['sediment']);
		expect(developmentProblemFields(developmentIssue(node({ kind: 'gauge', damInServiceFrom: '2020-01-01' })))).toEqual(['survey', 'sediment', 'in-service']);
		expect(developmentProblemFields(developmentIssue(node({ kind: 'gauge', abstractionFrom: '2020-01-01' })))).toEqual(['abstraction']);
	});
});
