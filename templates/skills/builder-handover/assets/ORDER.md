# Order for a builder (fill every line; drop none)

Goal: <one sentence: what exists when this is done>
Repository: <project slug with workdir — the builder works there; no cd in the order>
Context: <what the code does today, the parts this touches, conventions to keep (AGENTS.md/CLAUDE.md are read by the builder itself)>
Change: <what to build or change: areas, files, interfaces, data, behaviour — concrete>
Constraints: <dependencies allowed or not, style, what must not change, no remote/push unless granted>
Verification: <how the builder proves it: test command, manual check, expected output>
Done means: <observable, one line — goes into done_criteria>
Report: <absolute path inside the repository — goes into report_path>
Plan: <absolute path when a plan file exists — goes into plan_path; or phase: "plan" when the person wants the plan first>
Decisions: the builder decides routine choices itself and lists them in the report.
