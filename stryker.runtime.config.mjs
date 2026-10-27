import base from "./stryker.export.config.mjs";

export default {
  ...base,
  mutate: [
    "scripts/prepare-desktop.js:6-12",
    "scripts/prepare-desktop.js:48-54",
  ],
  commandRunner: { command: "node --test test/build-runtime.test.js" },
  ignorePatterns: [
    ...base.ignorePatterns,
    "!scripts/prepare-desktop.js",
    "!scripts/desktop-notices.js",
    "!test/build-runtime.test.js",
    "!.node-version",
    "!.github/workflows/quality.yml",
    "!package-lock.json",
  ],
  jsonReporter: { fileName: "reports/runtime-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/runtime-mutation/mutation.html" },
};
