// STUB (issue #610 foundation): the propose_settings agent replaces this.
import { TOOL_NAMES, type AssistantTool } from '../types.js';

export const proposeSettingsTool: AssistantTool = {
	spec: { name: TOOL_NAMES.proposeSettings, description: 'Not implemented yet.', parameters: { type: 'object', properties: {} } },
	label: 'Checking a settings change',
	run: async () => ({ ok: false, error: 'Not implemented yet.' })
};
