import { statSync, realpathSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The destination is chosen by the local operator, never by an agent argument.
// External copies are immutable and kept until the operator removes them.
export async function externalBackup(db, destination) {
  if (typeof destination !== "string" || !path.isAbsolute(destination))
    throw Error("BUDGET_BACKUP_DIR debe ser una carpeta absoluta existente.");
  const root = realpathSync(destination);
  if (!statSync(root).isDirectory())
    throw Error("El destino del respaldo debe ser una carpeta.");
  const source = db
    .prepare("SELECT source FROM event_identity WHERE singleton=1")
    .get().source;
  const identity = source.replace(/^urn:uuid:/, "");
  if (!/^[a-f0-9-]{36}$/i.test(identity))
    throw Error("Identidad del presupuesto inválida.");
  const folder = path.join(root, "Nemein-" + identity);
  mkdirSync(folder, { recursive: true });
  const file = path.join(
    folder,
    `budget-${new Date().toISOString().slice(0, 10)}-${randomUUID()}.db`,
  );
  const temp = file + ".tmp";
  try {
    await db.backup(temp);
    renameSync(temp, file);
    return file;
  } finally {
    rmSync(temp, { force: true });
  }
}
