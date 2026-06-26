import { exportDeepResearchForWorkflowAction } from '../deep-research.js';
import { registerWorkflowActionHandler } from './registry.js';

export function registerDeepResearchWorkflowActions(): void {
  registerWorkflowActionHandler({
    name: 'deep_research.export',
    description:
      'Generate Deep Research Markdown and printable HTML exports from report.json.',
    run(input) {
      const result = exportDeepResearchForWorkflowAction(input.workflow);
      if (result.status === 'failure') {
        return {
          status: 'failure',
          error: result.error,
          summary: result.error || 'Deep Research export failed',
        };
      }
      return {
        status: 'success',
        output: result.output,
        summary: 'Deep Research exports generated',
      };
    },
  });
}
