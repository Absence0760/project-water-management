// Every tool the assistant offers the model (issue #610): the read-only
// project tools (readTools.ts) and the settings recommendation
// (proposeSettings.ts). Each runs inside withUser(…, { readOnly: true }).
import type { AssistantTool } from '../types.js';
import { READ_TOOLS } from './readTools.js';
import { proposeSettingsTool } from './proposeSettings.js';

export const ASSISTANT_TOOLS: readonly AssistantTool[] = [...READ_TOOLS, proposeSettingsTool];
