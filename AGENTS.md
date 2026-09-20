# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles keep their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Decision maker

`decision_maker` ships as this repository's omp plugin, not as a project-local extension. Install it
with `omp plugin link .` (or `omp plugin install <git-url>` once the repository has a remote), then
start the session with `JEV_DECISION_MAKER=1` and `OPENROUTER_API_KEY` present in the environment.
Without both variables the tool is not registered and no request is sent.

The usage policy lives in [`rules/decision-maker.md`](./rules/decision-maker.md) and that file is the
source of truth - do not duplicate it here. omp loads it as a rule only from an *installed* plugin
root (`rules/*.md` of the linked or installed package, in sessions where rules are enabled); this
source repository does not load it by itself.
