export default {
  mutate: ["src/export.js", "src/event-reads.js"],
  testRunner: "command",
  commandRunner: {
    command:
      "node --test test/exports.test.js test/event-reads.test.js test/properties/export.property.test.js test/fuzz/export.test.js",
  },
  coverageAnalysis: "off",
  concurrency: 2,
  timeoutMS: 5000,
  timeoutFactor: 2,
  reporters: ["clear-text", "json", "html"],
  jsonReporter: { fileName: "reports/export-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/export-mutation/mutation.html" },
  thresholds: { high: 90, low: 90, break: 90 },
  ignorePatterns: [
    "**",
    "!src/**",
    "!test/exports.test.js",
    "!test/event-reads.test.js",
    "!test/properties/export.property.test.js",
    "!test/fuzz/export.test.js",
    "!package.json",
  ],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
