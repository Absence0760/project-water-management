// Picks the provider ASSISTANT_PROVIDER names (issue #610). `off` has none:
// the routes answer { available: false } and refuse messages.
import type { AssistantConfig } from '../config.js';
import type { AssistantProvider } from '../types.js';
import { mockProvider } from './mock.js';
import { ollamaProvider } from './ollama.js';
import { anthropicProvider } from './anthropic.js';
import { bedrockProvider } from './bedrock.js';

export function createProvider(cfg: AssistantConfig): AssistantProvider | null {
	switch (cfg.provider) {
		case 'off':
			return null;
		case 'mock':
			return mockProvider();
		case 'ollama':
			return ollamaProvider(cfg);
		case 'anthropic':
			return anthropicProvider(cfg);
		case 'bedrock':
			return bedrockProvider(cfg);
	}
}
