# Official Herdr Pi integration setup

DB11 Crew requires Herdr's official Pi integration for authoritative lifecycle and native session identity. Setup may write only Herdr's bundled extension at the target reported by `herdr integration status`:

- `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts` when `PI_CODING_AGENT_DIR` is set; otherwise
- `~/.pi/agent/extensions/herdr-agent-state.ts`.

Follow this read-only-first flow:

1. Run `/db11-crew-setup`. It reruns bounded local diagnostics, reads Herdr's bundled protocol/schema and integration status, and displays the exact command, target, and effects. It performs no mutation.
2. Present the plan and stop. Ask the requester separately whether to authorize exactly that official Herdr Pi integration write.
3. Only after a fresh explicit yes for that exact plan, run `/db11-crew-setup apply`.
4. Review the command's independent interactive confirmation. Cancellation leaves state unchanged.
5. The command executes only the argv vector `herdr integration install pi`, reruns read-only diagnostics, and succeeds only when Herdr reports the integration current.
6. Reload or restart Pi separately.

Never substitute `pi install`, `pi update`, `herdr update`, a package-filter edit, trust change, project-local extension, copied script, raw socket request, or hand-edited integration file. Setup does not uninstall or upgrade any other component. If the target is ambiguous, status cannot be parsed, the Pi agent directory is unsafe, or post-install verification fails, stop with sanitized remediation.
