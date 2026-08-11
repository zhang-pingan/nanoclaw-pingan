# Package Mode

Use package mode only for a frozen package created by an Icarus Analysis Run.

Required inputs:

- `context.json` with format `icarus.collaboration-analysis-input/1`
- `manifest.json` containing `analysis_id`, `snapshot_head`, `context_hash`, `prompt_hash`, and `challenge`
- `resources/catalog.json`
- `contracts/analysis-result.schema.json` or exported `result.schema.json`

Preserve every Host-owned binding exactly in an `icarus.collaboration-analysis-result/1` result. Do not replace, omit, recompute, or invent `analysis_id`, `snapshot_head`, `context_hash`, `prompt_hash`, or `challenge`.

Use only the frozen catalog and scope. Do not inspect a live Group checkout for additional evidence. Return one JSON object after running the validation scripts. Icarus Host validation remains authoritative and is the only path into the existing Analysis Run review and action-confirmation flow.
