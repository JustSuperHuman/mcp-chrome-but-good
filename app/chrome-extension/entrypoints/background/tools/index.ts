import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import * as browserTools from './browser';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';
import { browserSessionManager, takeJustBrowseContext } from './browser-session-manager';

const tools = { ...browserTools, flowRunTool, listPublishedFlowsTool } as any;
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (param: ToolCallParam) => {
  const { context, cleanArgs } = takeJustBrowseContext(param.args);
  if (param.name === '__justbrowse_release_session') {
    if (!context) return createErrorResponse('Missing JustBrowse session context');
    return await browserSessionManager.releaseSession(context.sessionId);
  }

  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  try {
    if (!context) return await tool.execute(cleanArgs);

    const prepared = await browserSessionManager.prepare(context.sessionId, param.name, cleanArgs);
    if (prepared.immediateResult) return prepared.immediateResult;

    const result = await tool.execute(prepared.args);
    await browserSessionManager.recordResult(context.sessionId, param.name, prepared.args, result);
    return result;
  } catch (error) {
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
};
