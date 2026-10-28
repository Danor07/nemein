export function date(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number(value.slice(0, 4)) < 1900 ||
    Number(value.slice(0, 4)) > 2200 ||
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw Error("Fecha inválida. Usá una fecha real entre 1900 y 2200.");
  return value;
}
