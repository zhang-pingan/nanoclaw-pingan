# Repository Mode

Repository mode builds a normalized, read-only analysis context without installing or running Icarus.

## Runtime

Require Node.js 20 or newer, Git with SSH commit-signature verification, and `ssh-keygen`. No npm install is required. Check the environment:

```bash
node scripts/check-runtime.mjs
```

Install a copied Skill without overwriting an existing installation:

```bash
node scripts/install.mjs --target /path/to/platform/skills/project-analyst
```

## Build context

For a local repository:

```bash
node scripts/repository-context.mjs \
  --repository /path/to/group-repository \
  --scope project \
  --output ./project-analysis-context
```

For `mine`, provide the exact Group principal ID:

```bash
node scripts/repository-context.mjs \
  --repository /path/to/group-repository \
  --scope mine \
  --principal-id principal_uuid \
  --output ./project-analysis-context
```

Other scope values are `work_item:<id>`, `workflow_instance:<id>`, and `delta:<full-commit-id>`. Use `--ref <ref>` only to override automatic `icarus/control` resolution. A Git URL is accepted anywhere `--repository` is accepted; the tool uses a disposable mirror clone. System, global, and source-repository Git configuration is isolated, so configured credential helpers are intentionally unavailable. Remote access may use transport credentials already exposed by the execution environment, such as an SSH agent. Never place credentials in the repository URL or analysis output.

Use `--trusted-genesis <full-commit-id>` or `--trusted-head <full-commit-id>` only when the user obtained that value through a trusted channel. A mismatch fails closed.

Git replacement refs and active local grafts are rejected. Repository reads and validation disable replacement objects and use controlled Git configuration; source `.git/config` programs such as `gpg.ssh.program` are not executed. The output must be outside a local source repository. Existing managed output paths must be regular files/directories: `--force` refuses symbolic links instead of following, deleting, or overwriting their targets.

The output contains:

```text
context.json
manifest.json
verification.json
result-template.json
resources/catalog.json
```

Create `analysis-result.json` from the template and `contracts/repository-analysis-result.schema.json`. This result is standalone and deliberately has no `analysis_id`, `prompt_hash`, or `challenge`.

Validate the report against the exact Context, manifest, and canonical evidence catalog:

```bash
node scripts/validate-result.mjs analysis-result.json \
  --context context.json --manifest manifest.json \
  --catalog resources/catalog.json
node scripts/verify-evidence.mjs context.json analysis-result.json
```

`resource_catalog_hash` binds the catalog to the Context hash closure, manifest, and repository Result. Replacing the catalog invalidates the report.

Strict verification is the default. `--allow-projection-only` is an explicit degraded mode for investigating materialized JSON after validation fails. Never use it for delta analysis or present its content as verified fact.
