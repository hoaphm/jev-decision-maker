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
with `omp plugin install github:hoaphm/jev-decision-maker` (or `omp plugin link .` from a clone - see
`README.md`), then start the session with `JEV_DECISION_MAKER=1`. The tool is registered only with that
switch; a call additionally needs an OpenRouter credential configured in omp itself, and resolves it
through omp's model registry rather than reading a key from the environment. Without a credential the
call answers `main`/`missing_key` and no request is sent.

The usage policy lives in [`rules/decision-maker.md`](./rules/decision-maker.md) and that file is the
source of truth - do not duplicate it here. omp loads it as a rule only from an *installed* plugin
root (`rules/*.md` of the linked or installed package, in sessions where rules are enabled); this
source repository does not load it by itself.
