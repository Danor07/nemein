import { installedAgentConfig } from "./agent-config.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { openBudget, today } from "./core.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp(budget, { installationRoots } = {}) {
  const app = express(),
    csrf = randomBytes(32).toString("hex"),
    previews = new Map();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(root, "views"));
  app.use((req, res, next) => {
    const host = req.headers.host || "";
    if (!/^127\.0\.0\.1:\d+$/.test(host))
      return res.status(403).send("Acceso local solamente.");
    res.set({
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      // Keep the local origin on HTML form POSTs; external links still receive no referrer.
      "Referrer-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.headers.origin &&
      req.headers.origin !== "http://" + host
    )
      return res.status(403).send("Origen no permitido.");
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: "8mb" }));
  app.use(express.json({ limit: "8mb" }));
  app.use((req, res, next) => {
    if (req.method === "POST") {
      const token = String(req.body._csrf || "");
      if (
        token.length !== csrf.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))
      )
        return res.status(403).send("Sesión vencida. Recargá la página.");
    }
    next();
  });
  app.use("/static", express.static(path.join(root, "public")));
  const connectionExports = new Map();
  function showConnection(req, res, connection) {
    const connectionConfig = installedAgentConfig(budget.dir, {
      runtimeRoot: root,
      installDirs: installationRoots,
      agentToken: connection.token,
      connectionVersion: connection.version,
    });
    for (const [id, entry] of connectionExports)
      if (Date.now() - entry.at > 600000) connectionExports.delete(id);
    const exportId = randomBytes(24).toString("hex");
    if (connectionConfig)
      connectionExports.set(exportId, {
        at: Date.now(),
        config: connectionConfig,
        token: connection.token,
        version: connection.version,
      });
    return render(req, res, {
      view: "access",
      newConnection: connection,
      connectionConfig,
      exportId,
    });
  }
  app.get("/agent-config", (_req, res) =>
    res
      .status(400)
      .json({
        code: "CONNECTION_REQUIRED",
        error:
          "Creá o renová una conexión desde Permisos y propuestas para descargar su configuración.",
      }),
  );
  app.post("/agent-config", (req, res, next) => {
    try {
      const entry = connectionExports.get(String(req.body.export_id || ""));
      if (!entry || Date.now() - entry.at > 600000)
        return res
          .status(410)
          .send(
            "La descarga venció. Renová el token desde Permisos y propuestas.",
          );
      budget.forAgent(entry.token, entry.version);
      res.attachment("nemein-mcp.json").json(entry.config);
    } catch (e) {
      next(e);
    }
  });
  app.get("/static/chart.js", (_req, res) =>
    res.sendFile("chart.umd.js", {
      root: path.join(root, "node_modules/chart.js/dist"),
    }),
  );
  app.locals.gs = (n) =>
    "Gs. " +
    new Intl.NumberFormat("es-PY", { maximumFractionDigits: 0 }).format(n);
  app.locals.displayDate = (d) => d.split("-").reverse().join("/");
  app.locals.today = today;
  app.locals.csrf = csrf;
  const render = (req, res, extra = {}) => {
    const activeView = extra.view || req.query.view || "home";
    const m = extra.error
        ? today().slice(0, 7)
        : req.query.month || today().slice(0, 7),
      s = budget.snapshot(m);
    res.render("index", {
      ...s,
      view: req.query.view || "home",
      overview: budget.overview(m),
      goals: budget.listGoals(m),
      recurring: budget.listRecurring(),
      transactions: budget.searchTransactions({
        month: m,
        query: req.query.q,
        account_id: req.query.filter_account,
      }),
      filters: {
        q: req.query.q || "",
        account: req.query.filter_account || "",
      },
      access:
        activeView === "access"
          ? budget.accessState({
              offset: Number(req.query.proposalOffset || 0),
            })
          : null,
      newConnection: null,
      connectionConfig: null,
      exportId: "",
      demo: process.env.BUDGET_DEMO === "1",
      notice: req.query.notice || "",
      error: "",
      preview: null,
      reconciliation: null,
      accountTx: [],
      selectedAccount: Number(req.query.account || s.accounts[0]?.id || 0),
      report: budget.reports(m),
      cube: budget.cube({
        from: m + "-01",
        to: new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0))
          .toISOString()
          .slice(0, 10),
        dimensions: ["account", "category"],
      }),
      mapping: s.accounts.length
        ? budget.mapping(req.query.account || s.accounts[0].id)
        : {},
      ...extra,
    });
  };
  app.get("/", (req, res, next) => {
    try {
      const s = budget.snapshot();
      const id = Number(req.query.account || s.accounts[0]?.id || 0);
      render(req, res, { accountTx: id ? budget.accountTransactions(id) : [] });
    } catch (e) {
      next(e);
    }
  });
  const redirect = (req, res, message) =>
    res.redirect(
      "/?" +
        new URLSearchParams({
          month: req.body.month || today().slice(0, 7),
          view: req.body.view || "budget",
          notice: message,
        }),
    );
  app.post("/action/:action", async (req, res, next) => {
    try {
      const p = req.body;
      switch (req.params.action) {
        case "connection-create":
          return showConnection(req, res, budget.createConnection(p));
        case "connection-rotate":
          return showConnection(req, res, budget.rotateConnection(p.id));
        case "connection-revoke":
          budget.revokeConnection(p.id);
          break;
        case "connection-version":
          budget.changeConnectionVersion(p);
          break;
        case "permission-set": {
          const conditions = {};
          for (const field of ["max_amount", "account_id"])
            if (p[field] !== undefined && p[field] !== "") {
              if (!/^\d+$/.test(String(p[field])))
                throw Error("El límite y la cuenta deben ser enteros.");
              conditions[field] = Number(p[field]);
            }
          if (Object.keys(conditions).length)
            conditions.otherwise = p.otherwise || "deny";
          budget.setRule({ ...p, conditions });
          break;
        }
        case "proposal-resolve":
          budget.resolveProposal({
            ...p,
            args: p.decision === "modify" ? JSON.parse(p.args) : undefined,
          });
          break;
        case "goal":
          budget.setGoal(p);
          break;
        case "goal-remove":
          budget.removeGoal(p);
          break;
        case "recurring-create":
          budget.createRecurring(p);
          break;
        case "recurring-post":
          budget.postRecurring(p);
          break;
        case "recurring-toggle":
          budget.toggleRecurring({ ...p, active: p.active === "true" });
          break;
        case "account":
          budget.createAccount(p);
          break;
        case "category":
          budget.createCategory(p);
          break;
        case "categorize":
          budget.categorize(p);
          break;
        case "group":
          budget.createGroup(p);
          break;
        case "allocate":
          budget.allocate(p);
          break;
        case "transaction":
          budget.addTransaction(p);
          break;
        case "transfer":
          budget.transfer(p);
          break;
        case "delete":
          budget.deleteTransaction(p.id);
          break;
        case "backup":
          await budget.backup();
          break;
        case "reconcile": {
          const ids =
            p.ids === undefined ? [] : Array.isArray(p.ids) ? p.ids : [p.ids];
          const result = budget.reconcile({ ...p, ids }, p.commit === "yes");
          if (p.commit !== "yes") {
            req.query.view = "reconcile";
            req.query.account = p.account_id;
            return render(req, res, {
              view: "reconcile",
              accountTx: budget.accountTransactions(p.account_id),
              selectedAccount: Number(p.account_id),
              reconciliation: { ...result, ids: ids.map(Number), date: p.date },
            });
          }
          break;
        }
        case "preview": {
          const config = {
            date: p.dateColumn,
            payee: p.payeeColumn,
            amount: p.amountColumn,
            delimiter: p.delimiter,
            dateFormat: p.dateFormat,
            thousands: p.thousands,
            category_id: p.category_id,
          };
          const result = budget.csvPreview(p.content, config, p.account_id);
          for (const [k, v] of previews)
            if (Date.now() - v.time > 1800000) previews.delete(k);
          if (previews.size >= 10)
            previews.delete(previews.keys().next().value);
          const id = randomBytes(20).toString("hex");
          previews.set(id, {
            content: p.content,
            config,
            account_id: p.account_id,
            time: Date.now(),
          });
          return render(req, res, {
            view: "import",
            preview: { ...result, id },
            selectedAccount: Number(p.account_id),
          });
        }
        case "import": {
          const pending = previews.get(p.previewId);
          if (!pending || Date.now() - pending.time > 1800000)
            throw Error(
              "La vista previa venció. Volvé a seleccionar el archivo.",
            );
          const result = budget.importCsv(pending);
          previews.delete(p.previewId);
          return redirect(
            req,
            res,
            `Se importaron ${result.added} movimientos. ${result.duplicates} ya existían.`,
          );
        }
        default:
          return res.sendStatus(404);
      }
      redirect(req, res, "Guardado correctamente.");
    } catch (e) {
      next(e);
    }
  });
  app.use((err, req, res, _next) => {
    let error = err.message;
    if (error.includes("UNIQUE constraint"))
      error = "Ya existe un registro con ese nombre.";
    res.status(400);
    try {
      req.query.month = undefined;
      render(req, res, { view: req.body?.view || "budget", error });
    } catch {
      res.send("No se pudo completar la operación. Revisá los datos.");
    }
  });
  return app;
}
export async function start() {
  const budget = openBudget();
  await budget.backup();
  const app = createApp(budget);
  const server = app.listen(Number(process.env.PORT || 0), "127.0.0.1", () =>
    process.stdout.write(
      "BUDGET_URL=http://127.0.0.1:" + server.address().port + "\n",
    ),
  );
  const timer = setInterval(
    () =>
      budget
        .backup()
        .catch((e) => console.error("Error de respaldo:", e.message)),
    60 * 60 * 1000,
  );
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    server.close(() => {
      budget.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Closing the native parent closes stdin. This also prevents orphan Node processes.
  if (process.env.BUDGET_DESKTOP === "1") {
    process.stdin.resume();
    process.stdin.on("end", stop);
  }
  return { server, budget };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
