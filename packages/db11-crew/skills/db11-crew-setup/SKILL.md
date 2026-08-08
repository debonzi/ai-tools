---
name: db11-crew-setup
description: Validate DB11 Crew prerequisites and, after a complete plan and explicit confirmation, install the official Herdr Pi integration when needed. Use only when the user explicitly invokes this setup skill or directly requests DB11 Crew setup.
compatibility: Requires Pi 0.83.0 or newer, Python 3, Git, and Herdr with Pi worker and integration support.
disable-model-invocation: true
---

# DB11 Crew Setup

Run this workflow only after an explicit user invocation or request for DB11 Crew setup. Do not install unrelated software, edit Pi package filters, change Pi trust decisions, or mutate any state before the user approves the complete plan.

DB11 Crew's skill and event extension are bundled in one Pi package and load together. This workflow never edits package resource filters.

## Preflight

Run these read-only checks from the requester's current working directory:

```bash
command -v pi
command -v python3
command -v git
command -v herdr
pi --version
python3 --version
git --version
herdr agent start --help
herdr integration install --help
herdr integration status
```

Validate all of the following:

- Pi, Python 3, Git, and Herdr are available.
- `herdr agent start --help` advertises Pi worker support.
- `herdr integration install --help` advertises the `pi` integration.
- `herdr integration status` reports whether the Pi integration is current, installed through a recognized legacy status, missing, or stale.

If a command is unavailable or a required Herdr capability is absent, stop and report the exact unmet prerequisite. Never install Pi, Python, Git, Herdr, or any other software on the user's behalf.

## Plan and confirmation

Before any mutation, show the complete proposed plan. Include:

1. the prerequisite and capability results;
2. the current Herdr Pi integration status;
3. whether the official integration command is required;
4. the exact command that would run, when required:

   ```bash
   herdr integration install pi
   ```

5. the final status verification and the request to reload or restart Pi;
6. an explicit statement that no package filters or trust decisions will change and no unrelated software will be installed.

If the integration is already current, do not propose or run a mutation. Otherwise ask for explicit confirmation of the complete plan. A general request to set up DB11 Crew is not confirmation to run the installation command; obtain a separate clear approval after presenting the plan.

## Apply

Only after explicit confirmation, run:

```bash
herdr integration install pi
herdr integration status
```

Accept `pi: current` and the recognized legacy `pi: installed` status as installed. If installation or verification fails, report the failure and the exact retry command without changing package settings, trust state, or unrelated files.

Finish by asking the user to run `/reload` or restart Pi when the package or integration became available to the current session.
