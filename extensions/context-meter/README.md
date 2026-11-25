# Pi Context Meter

Pi Context Meter adds the `pi-context-meter` tool. It reports the active model's used tokens, total context-window size, remaining tokens, and percentage used, based on Pi's session usage data.

Install the [AI Tools Pi package](../../README.md#install) and enable Context Meter in `pi config` if it was disabled. Remove any previous direct path to a standalone `pi-context-meter.ts` to avoid loading it twice.

Ask Pi to check its context window, for example: “How many tokens are left in this context window?” The tool takes no arguments and does not make a model request itself. If Pi has not reported usage yet, the tool marks unavailable values instead of guessing.
