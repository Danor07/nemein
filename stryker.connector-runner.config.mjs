import base from "./stryker.export.config.mjs";

// The host side of the connector enclosure: frames, limits, manifest and
// batch checks. Cheapest tests first; the fake supervisor is spawned last.
export default {
  ...base,
  mutate: ["src/connector-runner.js"],
  commandRunner: {
    command:
      "node --test test/properties/connector-runner.property.test.js test/fuzz/connector-runner.test.js && node --test test/connector-runner.test.js",
  },
  ignorePatterns: [
    ...base.ignorePatterns,
    "!src/connector-runner.js",
    "!test/connector-runner.test.js",
    "!test/properties/connector-runner.property.test.js",
    "!test/fuzz/connector-runner.test.js",
    "!test/helpers/fake-connector.js",
    "!src-tauri/connector/worker/fixtures/frames.json",
    "!src-tauri/connector/examples/fictitious-bank-csv/fixtures/**",
  ],
  jsonReporter: { fileName: "reports/connector-runner-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/connector-runner-mutation/mutation.html" },
};
