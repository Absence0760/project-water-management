// STUB (issue #610 foundation): replaced by the agent that owns this provider.
import type { AssistantConfig } from '../config.js';
import type { AssistantProvider } from '../types.js';

export function ollamaProvider(_cfg?: AssistantConfig): AssistantProvider {
	throw new Error('The ollama assistant provider is not implemented yet.');
}
