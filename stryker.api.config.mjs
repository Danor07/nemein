import base from "./stryker.export.config.mjs";

export default {
  ...base,
  // Negative HTTP tests fail at their socket deadlines before this runner deadline.
  timeoutMS: 20000,
  mutate: [
    "src/local-api.js",
    "src/access.js:171-171",
    "src/access.js:203-210",
    "src/server.js:17-17",
    "src/server.js:10-10",
  ],
  commandRunner: {
    command:
      "node --test test/local-api.test.js test/properties/local-api.property.test.js test/fuzz/local-api.test.js",
  },
  ignorePatterns: [
    "**",
    "!src/**",
    "!views/**",
    "!public/**",
    "!docs/openapi.v1.json",
    "!scripts/generate-openapi.js",
    "!test/openapi-generator.test.js",
    "!test/local-api-contract.test.js",
    "!test/local-api.test.js",
    "!test/helpers/local-api.js",
    "!test/helpers/openapi-schemas.js",
    "!test/properties/local-api.property.test.js",
    "!test/fuzz/local-api.test.js",
    "!package.json",
  ],
  jsonReporter: { fileName: "reports/api-mutation/mutation.json" },
  htmlReporter: { fileName: "reports/api-mutation/mutation.html" },
};
