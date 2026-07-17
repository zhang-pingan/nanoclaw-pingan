# Dynamic Workflow G2 Independent Semantic-Review Worksheet

> **状态**: HUMAN_SEMANTIC_REVIEW_COMPLETE / CHANGES_REQUESTED
> **范围**: G2.3 Draft v3 的逐 case 语义审查证据、human disposition 与修正边界
> **权威边界**: 本文不是 Contract、expected oracle、`GoldenSemanticReview`、approval 或 seal 输入
> **review owner**: `human:local-owner`
> **最后更新**: 2026-07-17

## 审查边界

本 worksheet 记录对 40 份 frozen raw source、case-bound historical snapshot、hand-authored review input 和 Production Compiler actual candidate 的逐项检查。Actual candidate 只作为 comparison input；本文没有从 actual result 生成 expected bytes。`human:local-owner` 已明确处理 SR-001 至 SR-011，并对全部 40 个 case 作出 worksheet-level `CHANGES_REQUESTED` 判断。

该判断不是 `GoldenSemanticReview` immutable record、Golden approval、签名或 seal。它只关闭 Draft v3 的独立语义审查并要求后续发布 additive 修正版；Codex 没有代替 human owner 决定或签名。

本切片没有修改 Draft v1/v2/v3、Production Compiler、actual candidates、G0/G1/R-016 frozen artifact 或 migration；没有写入 `conformance/sealed/`，没有运行 `golden-seal`，没有开始 G3+、certification、release 或 activation。

## Frozen Identity

| Identity              | Frozen value                                                              |
| --------------------- | ------------------------------------------------------------------------- |
| G0.10 root            | `sha256:21d06c2d9d45a47f6ebc68c24b9d0acec29c8ae1726d5387bd38c460a7a0a7ec` |
| G1 dependency         | `sha256:ea039f582f0ebff2fb9bc7e512825612cf8f0f93ccdd4c5e43345f56ca2b7b89` |
| G1 physical           | `sha256:8c667d62f69a8c67ba1edde467562e370377342a058b6dc4673ab9a383fe05a1` |
| G1 root               | `sha256:769800fbca754586f1eda90c28e876255a6af3fbe452c397a4dabfd4aec5b756` |
| migration             | `sha256:d89829995e164355ad485fc117db88dd67a72409f00ec3c3c54253f30a589f61` |
| R-016 root            | `sha256:776d516ba6c8c73a7da33895a4f4f3680054a1e93fbf056acdfc3ec36550b324` |
| G2 Compiler root      | `sha256:c78a12ffdec353d3d3ec40350aeb6676e991e92cd5d6645946d5e21fcb013a77` |
| G2 candidate manifest | `sha256:c471bcf03ea23ce2d84d5a785b026ae222ec47f7d5fd5948bb8e19c89904b1d2` |
| Resolved Draft v3     | `sha256:659caf9b4add7027116bf780c83b2b85dc95ca0baae9cb8b9840d760a785132b` |
| Review handoff        | `sha256:9e85abe94231efcbd35e39fd69d49eb10e8f1d6fe36117ba57d3fa60dc2a67f0` |

## Coverage

| Review surface                                         | Coverage | Result                                                                                                       |
| ------------------------------------------------------ | -------: | ------------------------------------------------------------------------------------------------------------ |
| Frozen raw source bytes                                |  40 / 40 | inspected                                                                                                    |
| Historical snapshot binding                            |  40 / 40 | 39 use `complete-base@1`; integrity case uses `compiler-integrity-mismatch@1`                                |
| Hand-authored diagnostics/assertions                   |  40 / 40 | inspected as review input, not oracle                                                                        |
| Actual candidate result                                |  40 / 40 | inspected as comparison input only; 10 compiled / 30 rejected                                                |
| Mechanical candidate-to-review-input comparison        |  40 / 40 | outcome and sparse diagnostic/assertion comparison has no mechanical mismatch; this is not semantic approval |
| Independently authored expected full case-result bytes |   0 / 40 | not authored in this slice                                                                                   |
| Explicit `human:local-owner` case judgment             |  40 / 40 | all `CHANGES_REQUESTED`; no case approved for expected-oracle authoring                                      |
| `GoldenSemanticReview` / approval / seal               |        0 | not run                                                                                                      |

Initial managed `npm run golden:draft:check` returned `check:ok` and root `659caf...5132b`. The `resolved-g2` file-tree digest was `4ce26fc340952095467f0b8ed77b14788a77771a1c18d7b4e4a0694cb93e1600` both before and after, with an empty Git diff/status, proving the check was read-only.

## Human Disposition

On 2026-07-17, the reviewer explicitly identified as `human:local-owner`, selected resolution A for SR-001 through SR-011, and explicitly judged all 40 cases as `CHANGES_REQUESTED`. These are worksheet decisions only.

| ID     | Human decision      | Required correction for an additive Draft/candidate version                                                                                                                                              |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-001 | `CHANGES_REQUESTED` | Make Definition state kind, lowered node kind and Capability `node_type` consistent; reject an unresolved mismatch.                                                                                      |
| SR-002 | `CHANGES_REQUESTED` | Provide the required Wait correlation input through a valid root input/data edge or other contract-valid binding.                                                                                        |
| SR-003 | `CHANGES_REQUESTED` | Make the static Subgraph interface satisfy the effective child interface allowlist.                                                                                                                      |
| SR-004 | `CHANGES_REQUESTED` | Add a positive Expand case whose frozen candidate actually implements the pinned child interface and succeeds when child compilation is exercised.                                                       |
| SR-005 | `CHANGES_REQUESTED` | Give the Map body a compatible `item` input and make its interface satisfy the effective child policy.                                                                                                   |
| SR-006 | `CHANGES_REQUESTED` | Make every static child closure member satisfy inherited interface and node-type allowlists.                                                                                                             |
| SR-007 | `CHANGES_REQUESTED` | Treat the current undocumented `child::child_done` token as an unknown ordinary Node ID; separately resolve how `graph_cross_scope_edge` can be reached without inventing an undocumented source syntax. |
| SR-008 | `CHANGES_REQUESTED` | Check the selected owning Recipe's reachable dependency closure and bind the negative case to a genuinely reachable Recipe cycle.                                                                        |
| SR-009 | `CHANGES_REQUESTED` | Repair the nine negative graphs so each has a valid terminal path and isolates its intended diagnostic instead of relying on fail-fast validation order.                                                 |
| SR-010 | `CHANGES_REQUESTED` | Redesign the case around an independently valid Capability contract and audit whether `early_completion_cancellation_unsafe` remains reachable under the published cancellation/effect rules.            |
| SR-011 | `CHANGES_REQUESTED` | Use isolated, independently valid case inputs with real contract/dependency/Definition hashes; each targeted negative case may introduce only its intended invalidity.                                   |

## Findings Requiring Correction

These findings remain open implementation work after the human `CHANGES_REQUESTED` decision. They are not `GoldenSemanticReview` decisions.

| ID     | Affected case(s)                                          | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-001 | `positive.static-lowering`                                | The raw Definition state is `delegation`, but `fixture.capability.static` has `node_type=system`. The actual Plan contains a `delegation` node whose embedded capability binding still says `system`. The node/capability execution kind is internally inconsistent.                                                                                                                                                                                                                                                         |
| SR-002 | `positive.wait`                                           | The approval Wait derives a required `single/only` `correlation_key` input, but raw source and actual Plan contain no data edge for it and the root interface has no input. The specification requires a required single input without a default to have a source binding.                                                                                                                                                                                                                                                   |
| SR-003 | `positive.subgraph`                                       | The static child uses `fixture.interface.root`, while the applied `child-tight` effective policy only allows `fixture.interface.child`. The actual candidate compiles and embeds the excluded interface.                                                                                                                                                                                                                                                                                                                     |
| SR-004 | `positive.expand`                                         | The parent Expand binding is structurally valid, but its literal candidate graph declares `fixture.interface.root` while `child_interface_ref` is `fixture.interface.child`. Parent compilation may defer candidate compilation to materialization, so this case does not demonstrate a successful Expand child compile and needs an explicit owner interpretation of the intended positive coverage.                                                                                                                        |
| SR-005 | `positive.map`                                            | The static body uses `fixture.interface.root`, which has no `item` input, but the Map declares `item_child_input_port=item`. It also violates the `child-tight` allowed-interface set. The actual candidate nevertheless compiles it.                                                                                                                                                                                                                                                                                        |
| SR-006 | `positive.static-child-closure`                           | Both static child scopes use excluded `fixture.interface.root`; additionally the nested child contains a `subgraph` node although `child-tight.allowed_node_types` contains only `system` and `terminal`. The actual candidate still publishes both closure members.                                                                                                                                                                                                                                                         |
| SR-007 | `negative.graph-cross-scope-edge`                         | The raw endpoint `child::child_done` relies on an undocumented `::` convention. Source IR defines endpoint fields as ordinary Node IDs and does not define child-path syntax, so `graph_cross_scope_edge` versus `graph_endpoint_not_found` is not uniquely derived from the published contract.                                                                                                                                                                                                                             |
| SR-008 | `negative.child-recipe-dependency-cycle`                  | The raw Definition has no child effect, and neither cyclic Recipe in the snapshot binds this Definition through `definition_ref`. The actual diagnostic comes from scanning unrelated unowned cyclic Recipes, not from a selected/owning Recipe and reachable entrypoint closure fixed by this case.                                                                                                                                                                                                                         |
| SR-009 | Nine negative graph cases                                 | `graph-endpoint-not-found`, `graph-dependency-cycle`, `json-pointer-non-total`, `schema-not-assignable`, `capability-not-allowed`, `policy-escalation`, and all three quality-revision negatives contain no parent-scope terminal node capable of producing `done`. They therefore also contain a structurally provable dead end, so the single expected diagnostic depends on fail-fast validation order rather than an isolated invalidity.                                                                                |
| SR-010 | `negative.early-completion-cancellation-unsafe`           | `fixture.capability.unsafe-cancel` combines `effect.type=idempotent` with `cancellation.type=requires_compensation`, while the contract requires `requires_compensation` to pair with a compensatable effect. The intended early-close diagnostic is therefore built on an already invalid capability contract.                                                                                                                                                                                                              |
| SR-011 | 39 cases using `complete-base@1` and five Definition raws | The shared snapshot contains deliberately invalid quality capabilities, the invalid unsafe-cancel pairing, cyclic Recipes, and placeholder zero dependency/contract hashes alongside positive resources. All five Definition raws also carry a zero `definition_hash`. The owner must decide whether these test-only placeholders and unreachable invalid resources are allowed, or whether positive and targeted negative cases require isolated, independently valid inputs before a full expected oracle can be authored. |

The integrity case is also `CHANGES_REQUESTED`. Its dedicated snapshot largely duplicates the same 23-resource base snapshot and represents the intended mismatch through a precomputed `compiler_identity.identity_match=false` flag. The additive correction must use an otherwise valid minimal snapshot, create a concrete exact-identity mismatch, require the Compiler to derive the mismatch from identity fields rather than trust a boolean verdict, and include a matching-identity control that compiles the same valid source.

## Positive Cases

`Candidate comparison` only states what the Production Compiler returned relative to the sparse hand-authored review input. It is not an expected result.

| Case                                    | Raw/snapshot semantic check                                                                                 | Candidate comparison                                                                 | Human judgment      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------- |
| `positive.static-lowering`              | SR-001                                                                                                      | compiled; sparse lowering assertions match, but node/capability kind conflicts       | `CHANGES_REQUESTED` |
| `positive.condition-route`              | first-matching route order and boolean operands are semantically consistent                                 | compiled; route order and operand-type assertions match                              | `CHANGES_REQUESTED` |
| `positive.wait`                         | SR-002                                                                                                      | compiled; Wait contract-ref assertion matches despite missing required input binding | `CHANGES_REQUESTED` |
| `positive.subgraph`                     | SR-003                                                                                                      | compiled; precompiled hash is present despite policy/interface mismatch              | `CHANGES_REQUESTED` |
| `positive.expand`                       | SR-004                                                                                                      | compiled; `graph_spec_input_port` assertion matches only the parent binding          | `CHANGES_REQUESTED` |
| `positive.map`                          | SR-005                                                                                                      | compiled; `result_order=item_index` matches despite invalid body binding             | `CHANGES_REQUESTED` |
| `positive.policy-intersection`          | requested `max_nodes=8` correctly tightens the Safety ceiling                                               | compiled; effective-limit assertion matches                                          | `CHANGES_REQUESTED` |
| `positive.quality-revision-binding`     | referenced quality capability has evaluator, gate, feedback schema and attempt-scope-compatible pure effect | compiled; feedback-schema assertion matches                                          | `CHANGES_REQUESTED` |
| `positive.sound-subtype-different-hash` | narrow enum `{accepted}` is a sound subset of `{accepted,rejected}`                                         | compiled; `enum_subset` proof assertion matches                                      | `CHANGES_REQUESTED` |
| `positive.static-child-closure`         | SR-006                                                                                                      | compiled; parent-before-descendant member assertions match despite policy violations | `CHANGES_REQUESTED` |

## Negative Cases

| Case                                                    | Raw/snapshot semantic check                                                         | Candidate comparison                                          | Human judgment      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------- |
| `negative.json-syntax-invalid`                          | raw bytes end after a comma and are syntactically incomplete                        | rejected; diagnostic tuple matches review input               | `CHANGES_REQUESTED` |
| `negative.json-duplicate-key`                           | raw object repeats `/scope_key`                                                     | rejected; duplicate-key pointer matches review input          | `CHANGES_REQUESTED` |
| `negative.schema-unknown-field`                         | top-level `compiler_hint` violates the closed source schema                         | rejected; diagnostic tuple matches                            | `CHANGES_REQUESTED` |
| `negative.schema-profile-keyword-unsupported`           | Workflow Schema uses forbidden `anyOf`                                              | rejected; diagnostic tuple matches                            | `CHANGES_REQUESTED` |
| `negative.registry-ref-unpinned`                        | interface version is `latest`                                                       | rejected; unpinned-ref diagnostic matches                     | `CHANGES_REQUESTED` |
| `negative.registry-ref-not-found`                       | interface exact ref is absent from the snapshot                                     | rejected; not-found diagnostic matches                        | `CHANGES_REQUESTED` |
| `negative.graph-id-duplicate`                           | two nodes use id `same`                                                             | rejected; duplicate-id diagnostic matches                     | `CHANGES_REQUESTED` |
| `negative.graph-endpoint-not-found`                     | target node `missing` is absent; SR-009 also applies                                | rejected; endpoint diagnostic matches                         | `CHANGES_REQUESTED` |
| `negative.graph-cross-scope-edge`                       | SR-007                                                                              | rejected; candidate uses the undocumented `::` classification | `CHANGES_REQUESTED` |
| `negative.graph-dependency-cycle`                       | `a -> b -> a` is a control dependency cycle; SR-009 also applies                    | rejected; cycle diagnostic matches                            | `CHANGES_REQUESTED` |
| `negative.condition-type-mismatch`                      | ordered comparison is string versus number                                          | rejected; type diagnostic matches                             | `CHANGES_REQUESTED` |
| `negative.condition-complexity-exceeded`                | condition requires more than requested `max_condition_steps=1`                      | rejected; complexity diagnostic matches                       | `CHANGES_REQUESTED` |
| `negative.json-pointer-non-total`                       | `/optional` is not total on a string output; SR-009 also applies                    | rejected; pointer diagnostic matches                          | `CHANGES_REQUESTED` |
| `negative.schema-not-assignable`                        | string producer cannot feed number consumer; SR-009 also applies                    | rejected; assignability diagnostic matches                    | `CHANGES_REQUESTED` |
| `negative.route-group-ambiguous`                        | first-matching edges share priority 10                                              | rejected; ambiguity diagnostic matches                        | `CHANGES_REQUESTED` |
| `negative.trigger-contract-invalid`                     | target with an incoming edge incorrectly declares root trigger                      | rejected; trigger diagnostic matches                          | `CHANGES_REQUESTED` |
| `negative.completion-contract-invalid`                  | selector references absent exit `missing_exit`                                      | rejected; completion diagnostic matches                       | `CHANGES_REQUESTED` |
| `negative.early-completion-non-monotone`                | early candidate predicate uses `eq`                                                 | rejected; monotonicity diagnostic matches                     | `CHANGES_REQUESTED` |
| `negative.early-completion-cancellation-unsafe`         | SR-010                                                                              | rejected; candidate emits early-cancellation diagnostic       | `CHANGES_REQUESTED` |
| `negative.capability-not-allowed`                       | capability is outside root allowlist; SR-009 also applies                           | rejected; capability diagnostic matches                       | `CHANGES_REQUESTED` |
| `negative.policy-escalation`                            | selected child profile expands policy and is not allowed; SR-009 also applies       | rejected; policy diagnostic matches                           | `CHANGES_REQUESTED` |
| `negative.quality-revision-missing-feedback-schema`     | selected capability has null feedback schema; SR-009 also applies                   | rejected; quality-contract diagnostic matches                 | `CHANGES_REQUESTED` |
| `negative.quality-revision-effect-key-incompatible`     | quality revision uses node-scoped idempotent key; SR-009 also applies               | rejected; effect-key diagnostic matches                       | `CHANGES_REQUESTED` |
| `negative.child-recipe-set-mismatch`                    | owning Recipe has an empty direct-child set but Definition reaches a required child | rejected; set-mismatch diagnostic matches                     | `CHANGES_REQUESTED` |
| `negative.child-recipe-dependency-cycle`                | SR-008                                                                              | rejected; candidate scans unowned cyclic Recipes              | `CHANGES_REQUESTED` |
| `negative.runtime-safety-limit-exceeded`                | 129 nodes exceed `max_nodes_per_scope=128`                                          | rejected; Safety diagnostic matches                           | `CHANGES_REQUESTED` |
| `negative.compiler-integrity-mismatch`                  | dedicated snapshot has `identity_match=false`                                       | rejected; integrity diagnostic matches                        | `CHANGES_REQUESTED` |
| `negative.quality-revision-missing-quality-gate`        | selected capability omits its required quality gate; SR-009 also applies            | rejected; quality-contract diagnostic matches                 | `CHANGES_REQUESTED` |
| `negative.definition-notification-delivery-requirement` | Notification adds removed `delivery_requirement`                                    | rejected; closed-schema pointer matches                       | `CHANGES_REQUESTED` |
| `negative.definition-child-creation-key-template`       | child effect adds removed `creation_key_template`                                   | rejected; closed-schema pointer and effect id match           | `CHANGES_REQUESTED` |

## Next Boundary

The next session must remain in G2 and prepare the additive correction required by the completed human review. It must first resolve the SR-007 diagnostic reachability, SR-010 cancellation-safety reachability and integrity-identity comparison contract, then repair Compiler behavior and isolated case inputs as required. Any source/snapshot/review-input/Compiler correction requires a new additive Draft/candidate version and a fresh independent review; frozen v1/v2/v3 artifacts must not be overwritten.

Expected full case-result bytes remain 0/40. Approval, immutable `GoldenSemanticReview`, `golden-seal`, sealed writes and CI replay remain not run and must occur only after a corrected additive Draft passes a fresh independent review. G3+ remains `NOT_READY` until the sealed Golden Gate is actually complete.
