import Ajv2020 from "ajv/dist/2020.js";

// Compiles against the published components, as an external client would.
export function schemaValidator(document) {
  const ajv = new Ajv2020({ strict: true });
  // These annotations do not affect validation of the data envelopes.
  ajv.addFormat("date-time", (value) => Number.isFinite(Date.parse(value)));
  ajv.addFormat(
    "uri-reference",
    (value) => typeof value === "string" && value.length > 0,
  );
  ajv.addSchema({
    $id: "urn:nemein:api-test",
    $defs: JSON.parse(
      JSON.stringify(document.components.schemas).replaceAll(
        "#/components/schemas/",
        "#/$defs/",
      ),
    ),
  });
  return (name) => ajv.compile({ $ref: "urn:nemein:api-test#/$defs/" + name });
}
