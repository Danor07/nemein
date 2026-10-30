import base from "./stryker.api.config.mjs";

// The pure contract needs no server: a mutant here costs a second, not a full HTTP suite.
export default {
  ...base,
  timeoutMS: 5000,
  mutate: [
    "src/local-api-contract.js",
    "src/openapi.js",
    "src/action-schemas.js",
    "scripts/generate-openapi.js",
  ],
  commandRunner: {
    command:
      "node --test test/openapi-generator.test.js test/local-api-contract.test.js",
  },
  jsonReporter: { fileName: "reports/api-contract-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/api-contract-mutation/mutation.html" },
};
