import { PROJECT_ANALYST_BUNDLE_FILES } from './analysis-capability-resources.generated.js';
import {
  buildCollaborationGenesisSelfDescriptionFromBundle,
  buildCollaborationGroupReadme,
  type CollaborationGenesisMaterializedFile,
} from './group-self-description-contract.js';

export { buildCollaborationGroupReadme };
export type { CollaborationGenesisMaterializedFile };

export function buildCollaborationGenesisSelfDescription(input: {
  readonly groupId: string;
}) {
  return buildCollaborationGenesisSelfDescriptionFromBundle({
    groupId: input.groupId,
    projectAnalystFiles: PROJECT_ANALYST_BUNDLE_FILES,
  });
}
