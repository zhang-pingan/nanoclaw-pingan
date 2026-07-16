# Dynamic Workflow G2 Contract Repair v1

> **状态**: NORMATIVE
> **Repair**: R-016
> **生效日期**: 2026-07-16
> **Base spec**: `local/docs/dynamic-workflow-dag-framework.md`
> **Base spec raw SHA-256**: `sha256:8f860bcba8c7f7e314d0ce115d505cbb00519d431fcfebce9bd2c387b70d8f1c`
> **Machine authority**: `src/workflow-runtime/contracts/conformance/compiler-contract-repair/`

## 范围与优先级

本文是 base spec 的 additive、versioned normative addendum，只修复 R-016 的 Compiler/Golden Contract 冲突。发生下列主题冲突时，本文与对应 machine Contract 优先于 base spec 的旧 `CompiledScopePlan/1`、Golden Draft v1和未定 target 表述：

- normalized semantic assertion target、canonical bytes与 hash identity；
- delegation/system static lowering 的 normal named exits、engine error与 cancellation outcome；
- `operand_types`、Map `result_order` 与 static child closure的 Compiled IR representation；
- frozen G0.8 case input到 exact G2 implementation identity的 additive binding；-上述 Contract、Draft与历史 artifact的 versioning规则。

其他 State、Graph、Store、Runtime、G3+、G8/G9、certification和 production activation语义仍完全由 base spec定义。本文不批准 Compiler实现、Golden review/seal或任何后续 Gate。

Base spec bytes 被 G0.10 Markdown coverage和 G1 Store identity精确引用，因此保持 immutable。本文通过新的 repair root绑定，不回写 G0.10/G1 artifacts。

## S38：R-016 唯一决策

G2 assertions 只指向 closed `WorkflowCompilerConformanceCaseResult/1`；Compiled IR bump为 `/2` 并纳入 condition operand types、Map item-index result order与 hashed static child closure；Definition static lowering的 normal exits与 error/cancel outcome分离；G0.8输入以新 version的 exact G2 identity binding additive绑定。任何 published historical Contract/Draft bytes不得原地改写。

## 唯一 Conformance Result

Normalized semantic assertions 的唯一 target artifact 是：

```ts
type WorkflowCompilerConformanceCaseResultV1 =
  | {
      format: 'icarus.workflow-compiler-conformance-case-result/1';
      case_id: string;
      source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
      source_hash: Sha256Hash;
      outcome: 'compiled';
      normalized_plan: CompiledScopePlanV2;
      static_lowering_contract_ref: VersionedRef | null;
      static_lowering_contract_hash: Sha256Hash | null;
      diagnostics: [];
      proof_hashes: Sha256Hash[];
      program_hashes: Sha256Hash[];
      result_hash: Sha256Hash;
    }
  | {
      format: 'icarus.workflow-compiler-conformance-case-result/1';
      case_id: string;
      source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
      source_hash: Sha256Hash | null;
      outcome: 'rejected';
      normalized_plan: null;
      static_lowering_contract_ref: null;
      static_lowering_contract_hash: null;
      diagnostics: WorkflowCompilerDiagnostic[];
      proof_hashes: Sha256Hash[];
      program_hashes: Sha256Hash[];
      result_hash: Sha256Hash;
    };
```

Closed schema固定为 `icarus.workflow-compiler-conformance-case-result-schema/1`。Compiled branch的 lowering ref/hash必须同时为 null或同时 non-null；rejected branch必须同时为 null。Unknown fields一律拒绝。

Assertion target的 closed identity固定为：

```ts
interface CompilerSemanticAssertionTargetV1 {
  artifact_format: 'icarus.workflow-compiler-conformance-case-result/1';
  schema_ref: string;
  schema_hash: Sha256Hash;
  pointer_root: '';
  canonicalization: 'rfc8785_jcs';
  encoding: 'utf-8';
  canonical_bytes: 'jcs_full_result_including_result_hash';
  hash_field: 'result_hash';
  hash_preimage: 'jcs_result_without_result_hash';
  hash_domain_separator: 'icarus:workflow-compiler-conformance-case-result:1\n';
}
```

每条 assertion只保存从完整 result root开始的 RFC 6901 `subject_pointer`；operator closed union为 `equals | set_equals | ordered_equals | contains | present | absent`。`/normalized` review projection、Golden report、Plan fragment或其他隐式对象都不是 target。

Hash与 bytes公式：

```text
result_hash = SHA-256(
  ASCII("icarus:workflow-compiler-conformance-case-result:1\n")
  || UTF8(RFC8785_JCS(result_without_result_hash))
)

canonical_result_bytes = UTF8(RFC8785_JCS(full_result_including_result_hash))
```

## Static Lowering Outcomes

Delegation/system static lowering 的 normal named exits只能是 `success`和 `failure`：

| Capability / Runtime fact       | GraphScopeOutcome       | Named exit | Definition route             |
| ------------------------------- | ----------------------- | ---------- | ---------------------------- |
| capability `succeeded`          | `completed`             | `success`  | `on_complete.success`        |
| capability `failed`             | `completed`             | `failure`  | `on_complete.failure`        |
| engine/invariant/compiler error | `errored`               | null       | `on_error`                   |
| local graph cancel              | `cancelled/local_graph` | null       | `on_local_cancel`            |
| global workflow cancel          | `cancelled/workflow`    | null       | 无 transition；终止 Workflow |

`error`、`local_cancel`、`workflow_cancel`不得出现在 lowered `GraphScopeInterfaceContract.exits`。四种 route不得互相 fallback。Closed machine Contract为 `icarus.workflow-definition-static-lowering-contract/1`，其 `contract_hash`使用 `icarus:workflow-definition-static-lowering-contract:1\n` 对去除自身 hash的 JCS payload计算。

## Compiled IR v2

G0.3发布的 `icarus.workflow-graph-scope-plan/1`与 schema/hash是 immutable historical artifact，不再作为 G2 Compiler output。当前 executable format固定为 `icarus.workflow-graph-scope-plan/2`。

### Condition program

```ts
type CompiledConditionOperandType =
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'array'
  | 'object';

interface CompiledConditionProgramV2 {
  normalized_ast: ConditionExpr;
  operand_schema_hashes: Record<string, Sha256Hash>;
  operand_types: CompiledConditionOperandType[];
  max_steps: number;
  program_hash: Sha256Hash;
}
```

`operand_types`按 normalized AST从左到右的 operand evaluation order保存每个 operand的 JSON category。它与其他 program字段一起进入 `program_hash`，domain separator固定为 `icarus:workflow-condition-program:2\n`。

### Map result order

`CompiledMapNodeV2`增加 required `result_order: 'item_index'`。Runtime与 Projection不得从 source、object insertion order或 child completion order重新推导。该字段进入 Plan canonical bytes/hash。

### Static child closure

```ts
interface CompiledStaticChildPlanClosureMemberV1 {
  closure_key: string;
  parent_closure_key: string | null;
  scope_key: string;
  owner_node_path: string[];
  factory_kind: 'inline' | 'template';
  source_ref: VersionedRef | null;
  source_hash: Sha256Hash;
  plan_ref: string;
  plan_hash: Sha256Hash;
  interface_snapshot_hash: Sha256Hash;
  member_hash: Sha256Hash;
}

interface CompiledStaticChildPlanClosureV1 {
  members: CompiledStaticChildPlanClosureMemberV1[];
  member_count: number;
  closure_hash: Sha256Hash;
}
```

`CompiledScopePlanV2.static_child_plan_closure`内嵌完整 hashed member manifest，替代v1的单独 `static_child_plan_closure_hash`字段。Members按 parent-before-descendant、同层 `closure_key` ascending排序；`member_count`等于长度且 key唯一。

- `member_hash`：domain `icarus:workflow-static-child-plan-closure-member:1\n`，preimage为去除 `member_hash`的 member JCS。
- `closure_hash`：domain `icarus:workflow-static-child-plan-closure:1\n`，preimage为 `{members,member_count}` JCS。
- `plan_hash`：domain `icarus:workflow-graph-plan:2\n`，preimage为去除 `plan_hash`的完整 Plan v2 JCS。

Child Plan bytes继续是独立 content-addressed Plan，由 `plan_ref/plan_hash`引用；closure manifest嵌入 parent Plan。`operand_types`、`result_order`和 closure members都是 executable IR字段，不是 review projection或独立 sealed Golden artifact。

## Additive G2 Input Binding

Frozen G0.8 case input与真实 G2 implementation identity通过下列 artifact结合：

```ts
interface CompilerG2CaseInputBindingV1 {
  format: 'icarus.workflow-compiler-g2-case-input-binding/1';
  binding_version: string;
  historical_g0_8_manifest_ref: string;
  historical_g0_8_manifest_hash: Sha256Hash;
  historical_case_catalog_ref: string;
  historical_case_catalog_hash: Sha256Hash;
  compiler_toolchain_manifest_ref: VersionedRef;
  compiler_toolchain_hash: Sha256Hash;
  compiler_version: string;
  compiler_build_hash: Sha256Hash;
  canonical_normalizer_version: string;
  canonical_normalizer_hash: Sha256Hash;
  proof_algorithm_version: string;
  proof_algorithm_hash: Sha256Hash;
  error_catalog_ref: VersionedRef;
  error_catalog_hash: Sha256Hash;
  compiled_ir_schema_ref: string;
  compiled_ir_schema_hash: Sha256Hash;
  conformance_result_schema_ref: string;
  conformance_result_schema_hash: Sha256Hash;
  case_inputs: CompilerG2CaseInputBindingEntryV1[];
  binding_hash: Sha256Hash;
}
```

每个 case entry精确包含 `case_id`、historical raw ref/hash、historical snapshot ref/hash和 `effective_case_input_hash`。Effective hash使用 `icarus:workflow-compiler-effective-case-input:1\n` 对这些 case字段加上 Toolchain Manifest、Compiler、Normalizer、Proof、Error Catalog、IR schema和result schema全部 exact ref/version/hash计算。`binding_hash`使用 `icarus:workflow-compiler-g2-case-input-binding:1\n` 对去除自身 hash的完整 binding计算。

G0.8 snapshot中的 `production_compiler_status/canonical_normalizer_status/proof_algorithm_status=absent`只描述 G0-stage historical fact，不是有效 G2 identity，也不得原地改为 present。真实实现 hashes不存在时只能发布 pending binding requirement；不得使用零值、占位或当前 Draft自身 hash伪装 resolved identity。

## Draft 与版本规则

- G0.3 Compiled IR v1与 G0.8 Golden Draft v1的 manifest、schemas、cases、raw bytes、snapshots和 hashes保持 byte-identical。
- R-016发布 `icarus.workflow-compiler-golden-draft-cases/2`与 manifest `/2`；40个 case全部复用 historical raw/snapshot refs与 hashes。
- Repair Draft v2的 exact G2 identity与 expected case result refs/hashes保持 null，状态固定 `blocked_pending_exact_g2_identity`；`GoldenSemanticReview` absent，seal not run。
- Compiler实现完成后必须发布另一个新的 Draft version绑定真实 identity和 candidate results；不得覆盖 Draft v1或 repair Draft v2。
- 任何 published Contract、Draft、Review或 Sealed Bundle的更正都发布新 version，旧 bytes/hash继续保留和验证。

## Gate 边界

R-016关闭后 G2/I2/I3可以进入 Compiler implementation，但 Golden approval/seal仍未授权。直到真实 Toolchain/Compiler/Normalizer/Proof identity、resolved binding、新 Draft expected results和 `human:local-owner`语义批准全部存在，`conformance/sealed/`必须只含 `.gitkeep`。

本文不创建或授权 `src/workflow-runtime/compiler/`实现、G3 Registry/Authoring/Publish、G8 certification、G9 release identity或 production activation。
