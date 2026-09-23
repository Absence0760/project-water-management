// Model entry point. Placeholder until the b023 port lands (docs/plan.md, phase 3).
import type { ModelInput, ModelOutput } from './project';

export const ENGINE_VERSION = '0.1.0';

export function runModel(_input: ModelInput): ModelOutput {
	throw new Error('runModel is not implemented yet');
}
