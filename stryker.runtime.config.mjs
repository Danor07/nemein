import base from "./stryker.export.config.mjs";

export default {
  ...base,
  mutate: [
    "scripts/prepare-desktop.js:6-12",
    "scripts/prepare-desktop.js:48-54",
    "scripts/prepare-connector.js",
  ],
  commandRunner: {
    command:
      "node --test test/build-runtime.test.js test/prepare-connector.test.js",
  },
  ignorePatterns: [
    ...base.ignorePatterns,
    "!scripts/prepare-desktop.js",
    "!scripts/prepare-connector.js",
    "!test/prepare-connector.test.js",
    "!scripts/desktop-notices.js",
    "!test/build-runtime.test.js",
    "!.node-version",
    "!.github/workflows/quality.yml",
    "!package-lock.json",
  ],
  jsonReporter: { fileName: "reports/runtime-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/runtime-mutation/mutation.html" },
};
