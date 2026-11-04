import base from "./stryker.export.config.mjs";

// Author signatures of connectors: Nemein's domain bytes, the strict file
// format, the check that informs without throwing, and the author's tool.
// Cheapest tests first.
export default {
  ...base,
  mutate: ["src/connector-signature.js", "scripts/connector-sign.js"],
  commandRunner: {
    command:
      "node --test test/properties/connector-signature.property.test.js test/fuzz/connector-signature.test.js && node --test test/connector-signature.test.js",
  },
  ignorePatterns: [
    "**",
    "!src/**",
    "!scripts/connector-sign.js",
    "!test/connector-signature.test.js",
    "!test/properties/connector-signature.property.test.js",
    "!test/fuzz/connector-signature.test.js",
    "!package.json",
  ],
  jsonReporter: {
    fileName: "reports/connector-signature-mutation/mutation.json",
  },
  htmlReporter: {
    fileName: "reports/connector-signature-mutation/mutation.html",
  },
};
