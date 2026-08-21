# Read-only diagnostics

Run `/db11-crew-doctor` before proposing setup or configuration changes. It performs only bounded local reads and argv-only version/schema/status probes:

- loaded DB11 Crew package identity;
- local Linux support;
- tested Pi, Herdr, Git, and Wyrd versions;
- Herdr's bundled API protocol/schema and required method set;
- official Herdr Pi integration status, including missing or stale installation;
- configuration-v2 validity and private-path safety, with bounded manual-replacement guidance for rejected files;
- current Pi project trust as a warning, without changing it.

The probe does not connect to a live Herdr socket, access remote services, run package installation/update, create DB11 durable state, or modify any file. It does not prove that the current session has a valid live Crewlead/Herdr binding; runtime startup rechecks that separately.

Interpret `BLOCK` as fail-closed for the affected package or role. Diagnostics never migrate or automatically rewrite configuration and never claim that ambient web or other same-user tools are available, restricted, or safe. `WARN` identifies a role-scoped or current-context limitation. Never resolve a failed probe by echoing raw configuration, environment, command output, credentials, full home paths, or suspicious file content. Follow only the sanitized remediation.
