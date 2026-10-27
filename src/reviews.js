import { isDeepStrictEqual } from "node:util";
import { goalProgress } from "./planning.js";

export const maxReviewTextBytes = 100000;
export const maxReviewPackageBytes = 2000000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const id = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw fail("INVALID_REVIEW", "Identificador de revisión inválido.");
  return value;
};
function object(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw fail("INVALID_REVIEW", "Opciones de revisión inválidas.");
}
function checkedPackage(value) {
  const result = JSON.stringify(value, (_key, v) => {
    if (typeof v === "number" && !Number.isSafeInteger(v))
      throw fail(
        "REVIEW_UNSAFE_NUMBER",
        "Un importe o contador no puede representarse exactamente.",
      );
    return v;
  });
  if (Buffer.byteLength(result) > maxReviewPackageBytes)
    throw fail(
      "REVIEW_TOO_LARGE",
      "El paquete supera 2 MB. Elegí un período menor.",
    );
  return result;
}

export function attachReviews(
  b,
  { date, today, snapshotAt, readTransaction, position },
) {
  const db = b.db;
  function calculate(p) {
    object(p, ["from", "to", "as_of"]);
    const as_of = date(p.as_of),
      from = date(p.from),
      to = date(p.to);
    if (from > to || to > as_of || as_of > today())
      throw fail(
        "INVALID_REVIEW_PERIOD",
        "El período debe terminar como máximo en el corte, y el corte no puede ser futuro.",
      );
    const { cursor } = position(); // First read pins the same snapshot as every metric below.
    const s = snapshotAt(as_of);
    const accounts = s.accounts.map((a) => ({
      ...a,
      last_reconciliation:
        db
          .prepare(
            "SELECT id,date,balance FROM reconciliations WHERE account_id=? AND date<=? ORDER BY date DESC,id DESC LIMIT 1",
          )
          .get(a.id, as_of) ?? null,
    }));
    const goals = db
      .prepare("SELECT * FROM goals ORDER BY due_date,category_id")
      .all()
      .map((g) =>
        goalProgress(
          g,
          s.categories.find((c) => c.id === g.category_id),
          s.month,
        ),
      );
    const metrics = b.cube({ from, to, dimensions: ["category"] });
    const evidence = db
      .prepare(
        "SELECT id,date,account_id,category_id,payee,amount,kind FROM transactions WHERE date BETWEEN ? AND ? ORDER BY date,id LIMIT 5001",
      )
      .all(from, to);
    if (evidence.length > 5000)
      throw fail(
        "REVIEW_TOO_LARGE",
        "El paquete supera 5000 movimientos. Elegí un período menor.",
      );
    const result = {
      version: 1,
      currency: "PYG",
      unit: "integer",
      period: { from, to },
      as_of,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cursor,
      recorded: {
        accounts,
        ready: s.ready,
        categories: s.categories,
        metrics: metrics.totals,
        by_category: metrics.rows,
        goals,
      },
      projected: { upcoming: b.listRecurring().filter((r) => r.active) },
      coverage: "not_declared",
      evidence,
    };
    checkedPackage(result);
    return result;
  }
  b.reviewPackage = (p) => readTransaction(() => calculate(p));
  // Called within the access layer's write transaction. Recompute before accepting
  // agent-supplied numbers; a changed ledger requires a new package in v1.
  b.saveReview = (p) => {
    object(p, ["id", "package", "report", "generator"]);
    id(p.id);
    if (
      typeof p.report !== "string" ||
      Buffer.byteLength(p.report) > maxReviewTextBytes
    )
      throw fail(
        "INVALID_REVIEW_TEXT",
        "El informe debe ser texto plano de hasta 100000 bytes.",
      );
    if (
      typeof p.generator !== "string" ||
      !p.generator.trim() ||
      p.generator.length > 160
    )
      throw fail(
        "INVALID_REVIEW_GENERATOR",
        "Indicá quién redactó el informe, hasta 160 caracteres.",
      );
    object(p.package, [
      "version",
      "currency",
      "unit",
      "period",
      "as_of",
      "time_zone",
      "cursor",
      "recorded",
      "projected",
      "coverage",
      "evidence",
    ]);
    const package_json = checkedPackage(p.package),
      author = b.reviewAuthor();
    const existing = db.prepare("SELECT * FROM reviews WHERE id=?").get(p.id);
    if (existing) {
      if (
        existing.generated_by !== author ||
        existing.report !== p.report ||
        existing.generator !== p.generator ||
        !isDeepStrictEqual(JSON.parse(existing.package_json), p.package)
      )
        throw fail(
          "REVIEW_ID_REUSED",
          "Ese identificador ya pertenece a otro informe.",
        );
      return { id: existing.id, created_at: existing.created_at };
    }
    object(p.package.period, ["from", "to"]);
    const expected = calculate({ ...p.package.period, as_of: p.package.as_of });
    if (!isDeepStrictEqual(expected, p.package))
      throw fail(
        "REVIEW_STALE",
        "El paquete cambió o no corresponde a este presupuesto. Generá otro y revisá el informe antes de guardar.",
      );
    const created_at = new Date().toISOString();
    db.prepare(
      "INSERT INTO reviews(id,package_json,report,generated_by,generator,created_at) VALUES (?,?,?,?,?,?)",
    ).run(p.id, package_json, p.report, author, p.generator, created_at);
    return { id: p.id, created_at };
  };
  b.listReviews = (p = {}) => {
    object(p, ["offset"]);
    const offset = p.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw fail("INVALID_REVIEW", "Posición de lista inválida.");
    return {
      items: db
        .prepare(
          "SELECT id,generator,generated_by,created_at,reviewed_at FROM reviews ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET ?",
        )
        .all(offset),
      offset,
      total: db.prepare("SELECT COUNT(*) n FROM reviews").get().n,
    };
  };
  b.getReview = (p) => {
    object(p, ["id"]);
    const r = db.prepare("SELECT * FROM reviews WHERE id=?").get(id(p.id));
    if (!r) throw fail("REVIEW_NOT_FOUND", "La revisión no existe.");
    const { package_json, ...rest } = r;
    return { ...rest, package: JSON.parse(package_json) };
  };
  b.markReview = (p) => {
    object(p, ["id"]);
    const result = db
      .prepare(
        "UPDATE reviews SET reviewed_at=COALESCE(reviewed_at,?) WHERE id=?",
      )
      .run(new Date().toISOString(), id(p.id));
    if (!result.changes)
      throw fail("REVIEW_NOT_FOUND", "La revisión no existe.");
    return { id: p.id };
  };
}
