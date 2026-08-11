import crypto from 'node:crypto';

import {
  COLLABORATION_GROUP_README_PATH,
  COLLABORATION_PROJECT_ANALYST_ROOT,
  PROJECT_ANALYST_BUNDLE_RELATIVE_PATHS,
} from './project-analyst-bundle.js';
import type { CollaborationGroupSelfDescription } from './protocol/v4-schema.js';
import { COLLABORATION_CONTROL_BRANCH } from './protocol/version.js';

export interface CollaborationProjectAnalystBundleFile {
  readonly path: string;
  readonly contents: string | Buffer;
}

export interface CollaborationGenesisMaterializedFile {
  readonly path: string;
  readonly contents: string | Buffer;
}

function sha256(contents: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`;
}

function digest(path: string, contents: string | Buffer) {
  return {
    path,
    size: Buffer.byteLength(contents),
    sha256: sha256(contents),
  };
}

export function buildCollaborationGroupReadme(groupId: string): string {
  return `# Icarus Collaboration Group Git

This repository is the durable collaboration record for Icarus Group \`${groupId}\`.
Icarus is not required to read, inspect, or analyze it. Humans and general-purpose
agents can start here with ordinary Git, JSON, Markdown, and the portable Project
Analyst Skill included in this repository.

## Repository identity

- Control branch: \`${COLLABORATION_CONTROL_BRANCH}\`
- Group id: \`${groupId}\`
- Remote URL: the clone-specific transport locator shown by \`git remote get-url origin\`

The control branch selects the protocol history, and its verified \`group.json\`
selects the \`group_id\`. Icarus binds that pair to the configured remote URL in
local subscription state. A remote URL is a locator, not a signed identity claim:
the same URL can be initialized to a new, unrelated Genesis and \`group_id\`.

Bare Group remotes commonly do not point their default \`HEAD\` at the control
branch. Clone and check out the protocol branch explicitly:

\`\`\`bash
git clone --single-branch --branch icarus/control <remote-url> <directory>
cd <directory>
git remote get-url origin
git rev-parse --verify refs/remotes/origin/icarus/control
\`\`\`

## Repository map

| Path | Responsibility and format |
| --- | --- |
| \`README.md\` | This human and agent orientation document. Markdown, fixed by the signed Genesis self-description manifest. |
| \`group.json\` | Current Group settings and lifecycle Projection. Strict JSON. |
| \`events/\` | Immutable v4 event streams by Aggregate, plus ordered batch manifests. Strict JSON; the signed event envelope is authoritative after verification. |
| \`members/\` | Materialized Principal membership, Client, Credential, and Executor descriptors. Strict JSON. |
| \`permissions/\` | Current per-Principal permission grants. Strict JSON. |
| \`workspace/shared/\` | Shared files and first-class links. Link metadata is strict JSON under \`links/{link_id}/metadata.json\`; document bytes retain their business format and are hash/size bound. |
| \`workspace/principals/\` | Principal-owned progress, files, links, Actions, and Markdown Prompts. Link metadata is separate from file metadata; business files retain their format. |
| \`work-items/\` | Work Item state, relations, progress, and attachments. Machine state is JSON; attached business files retain their format. |
| \`discussions/\` | Discussion metadata and append/revision/tombstone Message projections. Strict JSON. |
| \`workflows/definitions/\` | Versioned Workflow Definition, machine, and layout contracts. Strict JSON. |
| \`workflows/instances/\` | Workflow Instance state, assignment/execution records, and Turns. Strict JSON. |
| \`artifacts/\` | Work Item and Workflow Turn artifacts with JSON metadata and hash-bound original bytes. |
| \`projections/\` | Rebuildable current views derived from verified events. Strict JSON; never an independent authority. |
| \`${COLLABORATION_PROJECT_ANALYST_ROOT}/\` | Complete portable Project Analyst Skill: instructions, scripts, contracts, references, and agent metadata. |

Machine protocols and structured state use JSON. Human documentation and Prompts
use Markdown. Business files keep their original formats and are interpreted only
through their verified JSON metadata.

## Core concepts

- A **Principal** is the collaboration subject. A **Client** is one registered
  installation acting for that Principal. A **Credential** binds a signing public
  key to one Principal and Client.
- An **Executor** is an agent execution capability registered under a Principal.
  An **Action** is a versioned execution definition and hash-bound Markdown Prompt;
  selecting an Executor does not change Action ownership or Principal authority.
- A **Work Item** is a deliverable or task with ownership, status, relations,
  contributors, evidence, and optional Workflow linkage.
- A **Workflow Definition** is a versioned state machine and layout. A **Workflow
  Instance** is one execution of a Definition. A **Turn** is one fenced attempt to
  execute an active state, optionally producing results, handoff data, and artifacts.
- A **Discussion** is a scoped thread whose Messages retain author, revision,
  mention, reference, and up to ten embedded link attachments. Progress updates
  may carry the same bounded link attachments without promoting them to Workspace.
- A **Workspace Link** is a durable Shared or Principal-owned resource with its
  own id, URL/URI, title, description, revision, business refs, and ownership
  location. It is not a File or an external file locator. Link content is never
  fetched into the Icarus renderer; opening is delegated to the host system.

## Trust and verification boundary

Do not trust a file merely because it exists in this tree. Full verification resolves
the control ref, requires linear Git history, validates strict event JSON and payload
hashes, checks each Aggregate revision and previous-event hash, verifies each commit
signature against the active actor Credential, replays the Reducer, and compares every
authorized materialized path and hash-bound business file with the replay result.

The **verified head** is the last commit for which that complete process succeeded.
Materialized files, including this README and the embedded Skill, are Projections of
signed events within that boundary. The current Icarus validator also requires the
Genesis manifest and every README/Skill byte to equal its current canonical build;
the event's self-reported hashes alone are not a trust anchor. Later events cannot use
these paths as arbitrary write paths. A signature proves key possession, not a
real-world identity, and a self-consistent repository is not externally authenticated
unless its Genesis or head was obtained through a trusted channel.

The embedded Skill cannot prove its own integrity. Execute its scripts only after a
current Icarus validator has accepted this repository, or after the Genesis, verified
head, and bundle provenance have been confirmed through a trusted channel. For an
unknown or untrusted repository, do not execute any script from that repository. Use
a Project Analyst Skill obtained from a trusted Icarus release or independent trusted
channel and point that copy at the repository instead.

## Quick reading path

1. Read this README for an initial, non-executing view of the repository contract and
   trust boundary.
2. Inspect \`group.json\`, then the relevant \`events/\` stream and its materialized
   business paths. Treat them as claims until protocol verification succeeds.
3. After confirming provenance as described above, use
   [the embedded Skill](${COLLABORATION_PROJECT_ANALYST_ROOT}/SKILL.md) and its
   [repository-mode guide](${COLLABORATION_PROJECT_ANALYST_ROOT}/references/repository-mode.md)
   for structured analysis.

## Portable repository analysis

Repository mode needs Node.js 20 or newer, Git 2.34 or newer, and \`ssh-keygen\`.
It does not require Icarus or \`npm install\`. Once the embedded bundle's provenance
has been confirmed, run from this repository root:

\`\`\`bash
node ${COLLABORATION_PROJECT_ANALYST_ROOT}/scripts/check-runtime.mjs
node ${COLLABORATION_PROJECT_ANALYST_ROOT}/scripts/repository-context.mjs \\
  --repository . \\
  --scope project \\
  --output ../icarus-project-analysis
\`\`\`

For an unknown repository, use the same arguments with a trusted external Skill; the
script path must come from the trusted copy, while \`--repository\` names the target:

\`\`\`bash
node /trusted/project-analyst/scripts/repository-context.mjs \\
  --repository /path/to/untrusted-group-repository \\
  --scope project \\
  --output /path/outside-repository/icarus-project-analysis
\`\`\`

The input boundary is a read-only local Group repository or Git URL plus an analysis
scope. Optional trusted Genesis/head commits must come from an external trusted channel.
The output directory must be outside the Group repository and contains \`context.json\`,
\`manifest.json\`, \`verification.json\`, \`result-template.json\`, and
\`resources/catalog.json\`. Repository mode does not create an Icarus Analysis Run,
modify this repository, or execute a proposed action.

After creating \`analysis-result.json\` from the template, validate the result and its
evidence closure from this repository root with the same provenance-confirmed Skill:

\`\`\`bash
node ${COLLABORATION_PROJECT_ANALYST_ROOT}/scripts/validate-result.mjs \\
  ../icarus-project-analysis/analysis-result.json \\
  --context ../icarus-project-analysis/context.json \\
  --manifest ../icarus-project-analysis/manifest.json \\
  --catalog ../icarus-project-analysis/resources/catalog.json
node ${COLLABORATION_PROJECT_ANALYST_ROOT}/scripts/verify-evidence.mjs \\
  ../icarus-project-analysis/context.json \\
  ../icarus-project-analysis/analysis-result.json
\`\`\`

The package mode documented by the same Skill remains reserved for a frozen,
Host-bound Icarus Analysis Package. Repository-mode output is standalone and cannot be
submitted as a package-mode result.
`;
}

export function buildCollaborationGenesisSelfDescriptionFromBundle(input: {
  readonly groupId: string;
  readonly projectAnalystFiles: readonly CollaborationProjectAnalystBundleFile[];
}): {
  readonly manifest: CollaborationGroupSelfDescription;
  readonly materializedFiles: readonly CollaborationGenesisMaterializedFile[];
} {
  const actualPaths = input.projectAnalystFiles.map((file) => file.path);
  if (
    actualPaths.length !== PROJECT_ANALYST_BUNDLE_RELATIVE_PATHS.length ||
    actualPaths.some(
      (file, index) => file !== PROJECT_ANALYST_BUNDLE_RELATIVE_PATHS[index],
    )
  )
    throw new Error('Project Analyst bundle file set is not canonical');

  const readme = buildCollaborationGroupReadme(input.groupId);
  return {
    manifest: {
      format: 'icarus.collaboration-group-self-description/1',
      readme: digest(COLLABORATION_GROUP_README_PATH, readme),
      project_analyst: {
        root: COLLABORATION_PROJECT_ANALYST_ROOT,
        files: input.projectAnalystFiles.map((file) =>
          digest(file.path, file.contents),
        ),
      },
    },
    materializedFiles: [
      { path: COLLABORATION_GROUP_README_PATH, contents: readme },
      ...input.projectAnalystFiles.map((file) => ({
        path: `${COLLABORATION_PROJECT_ANALYST_ROOT}/${file.path}`,
        contents: file.contents,
      })),
    ],
  };
}
