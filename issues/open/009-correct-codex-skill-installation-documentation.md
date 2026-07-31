---
created: 2026-07-31
status: open
title: "Correct Codex Skill Installation Documentation"
dependencies:
  - "008-separate-shared-dbz-crew-documentation"
---

## Description

Correct the root `README.md` statement that the Codex installer links every shared skill directly into the Codex skills directory. The installer links `dbz-spec` directly, while DBZ Crew is supplied through the `dbz-crew@dbz-ai-tools` adapter plugin and its packaged skill.

After the shared DBZ Crew documentation is moved to its final section, describe the direct skill link and plugin-provided integration separately. Keep the wording aligned with `install.sh` and the Codex plugin package so agents do not infer unsupported installation behavior.
