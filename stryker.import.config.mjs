export default {
  mutate: ["src/import-contract.js", "src/date.js", "src/core.js:324-333"],
  testRunner: "command",
  commandRunner: {
    command:
      "node --test test/import-contract.test.js test/import-csv.test.js test/properties/import.property.test.js test/fuzz/import.test.js",
  },
  coverageAnalysis: "off",
  concurrency: 2,
  timeoutMS: 5000,
  timeoutFactor: 2,
  reporters: ["clear-text", "json", "html"],
  jsonReporter: { fileName: "reports/import-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/import-mutation/mutation.html" },
  thresholds: { high: 90, low: 90, break: 90 },
  ignorePatterns: [
    "**",
    "!src/**",
    "!test/import-contract.test.js",
    "!test/import-csv.test.js",
    "!test/fixtures/import-vectors.json",
    "!test/properties/import.property.test.js",
    "!test/fuzz/import.test.js",
    "!package.json",
  ],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
