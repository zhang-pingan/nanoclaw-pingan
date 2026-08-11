# Repository Trust Model

## Validator provenance comes first

An embedded validator cannot prove its own code is trustworthy. Execute a Group
repository's embedded Skill only after a current Icarus validator has accepted the
repository, or after the Genesis, verified head, and exact bundle provenance were
confirmed through a trusted channel. When the repository is unknown, do not execute
its scripts; use Project Analyst obtained from a trusted Icarus release or an independent
trusted channel to inspect the target. This bootstrap rule does not prevent a trusted
Group clone from using its complete embedded Skill without installing Icarus.

Repository mode reports one of four guarantee levels:

| Level             | Guarantee                                                                                                                                                                                                                                                                                       | Repository identity claim                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verified`        | Git/ref, linear commit history, strict protocol JSON, payload hashes, aggregate revisions and previous hashes, commit order, SSH signatures and actor Credentials, full Reducer replay, materialized Projection, and business-file hashes all pass. A supplied trusted genesis or head matches. | Verified only relative to the caller-supplied trusted commit.                                                                                                                  |
| `self_consistent` | The same complete internal validation passes.                                                                                                                                                                                                                                                   | No external repository identity or real-world actor identity is established. Genesis credentials are trusted only because they are self-declared inside the validated history. |
| `projection_only` | Strict validation failed, but materialized Projection JSON was explicitly loaded with `--allow-projection-only`.                                                                                                                                                                                | No event-chain, signature, Reducer, materialization-integrity, or repository-identity guarantee.                                                                               |
| `unverified`      | Ref resolution or strict validation failed and no analysis context was created.                                                                                                                                                                                                                 | None. Diagnostic output only.                                                                                                                                                  |

Git signatures prove possession of the private key corresponding to the public Credential recorded by the history. Without a trusted genesis/head commitment or another external identity system, they do not prove who controls that key in the real world.

Commit timestamps and event `occurred_at` values are signed claims, not trusted absolute time. Repository access permissions and Git transport identity are outside this tool's proof boundary.

Repository inspection runs against a disposable mirror clone. Every Git subprocess clears inherited `GIT_*` settings, disables system and global Git configuration and system attributes, disables replacement objects, pins the SSH signature verifier to `ssh-keygen`, disables hooks and fsmonitor, and restricts transport protocols. Local repository configuration, including `gpg.ssh.program`, is therefore not trusted or executed during validation.

The tool rejects any `refs/replace` namespace in the source or mirror and rejects active local `.git/info/grafts` state. Trusted commits, ref resolution, history traversal, object reads, signature checks, and Reducer replay consequently use the same unreplaced object graph. Remote-only graft state cannot be transported by Git and is outside the received repository object graph.

Strict validation proves internal consistency at the resolved commit, subject to the stated trusted-input boundary. It does not prove that a remote server returned the intended repository, that a transport account is a Group member, or that self-declared genesis credentials belong to named people.
