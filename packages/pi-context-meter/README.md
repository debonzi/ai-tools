# Pi Context Meter

Pi Context Meter adds the `pi-context-meter` tool. It reports the active model's used tokens, total context-window size, remaining tokens, and percentage used, based on Pi's session usage data.

## Install

When the package is available on npm:

```sh
pi install npm:@debonzi/pi-context-meter
```

From the repository root, install from source instead:

```sh
pi install ./packages/pi-context-meter
```

If Pi is already running, restart it or run `/reload`. If you loaded the former standalone `pi-context-meter.ts` by path, remove that path from your Pi settings or launch command before loading the package.

## Use

Ask Pi to check its context window, for example: “How many tokens are left in this context window?” The tool takes no arguments and does not make a model request itself. If Pi has not reported usage yet, the tool marks unavailable values instead of guessing.

## Test from source

From the repository root, with the locked development dependencies available:

```sh
node --test packages/pi-context-meter/agents/pi/extensions/pi-context-meter/index.test.ts
npm run test:install -- pi-context-meter
```
