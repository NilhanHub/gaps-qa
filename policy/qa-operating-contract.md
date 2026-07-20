# QA Operating Contract

GAPS QA is a browser-truth audit system. It does not infer feature correctness from repository structure or copy alone.

## Core rules

- Browser behavior is the source of truth.
- A visible UI is not proof that a workflow works.
- A button is not proof that an action succeeds.
- Success toasts are not proof unless state changes persist after refresh or revisit.
- If a surface is gated, blocked, or unsafe to mutate, it must be marked `BLOCKED` or `UNVERIFIED`, never silently skipped.

## Required run phases

1. Target resolution
2. Authentication attempt
3. Surface discovery
4. Component inventory
5. Workflow inference
6. Workflow execution
7. Critical re-test
8. Report assembly
9. Verdict

## Allowed status vocabulary

- `PASSED`
- `FAILED`
- `BLOCKED`
- `UNVERIFIED`

## Allowed verdict vocabulary

- `PASS`
- `PASS_WITH_ISSUES`
- `FAIL`

## Canonical outputs

- `docs/qa/QA_Summary.md`
- `docs/qa/App_Surface_Map.md`
- `docs/qa/UI_Component_Inventory.md`
- `docs/qa/UI_Element_Writeups.md`
- `docs/qa/UI_Element_Writeups.docx`
- `docs/qa/Workflow_Coverage.md`
- `docs/qa/Findings.md`
- `docs/qa/Human_Test_Narrative.md`
- `docs/qa/Blocked_and_Untested.md`
- `docs/qa/Readiness_Scorecard.md`
- `docs/qa/artifacts/report/ui-element-audit.json`
- `docs/qa/artifacts/screenshots/*`
- `docs/qa/artifacts/traces/*`
- `docs/qa/artifacts/network/*`
- `docs/qa/artifacts/console/*`

## Safety defaults

- Default to non-destructive behavior.
- Treat public unknown targets conservatively.
- Stop before irreversible destructive confirmations unless the run explicitly allows risky writes in non-production environments.
