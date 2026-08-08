# @debonzi/dbz-crew

DBZ Crew resources for explicitly delegating work from Pi to Pi workers through Herdr.

The package keeps the `dbz-crew` skill and CLI, the explicit `dbz-crew-setup` workflow, and the `dbz-crew-events` Pi extension together because they share one completion protocol and lifecycle.

Install with `pi install npm:@debonzi/dbz-crew`, reload or restart Pi, then explicitly run `/skill:dbz-crew-setup` when prerequisite or integration setup is needed.
