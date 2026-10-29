// Saves every permission of a connection at once, without reloading the page.
const forms = document.querySelectorAll("[data-permissions-form]");
const snapshot = (form) => new URLSearchParams(new FormData(form)).toString();
const dirtyCount = (form) => {
  const saved = new URLSearchParams(form.dataset.saved);
  let count = 0;
  for (const row of form.querySelectorAll("[data-permission-row]")) {
    const fields = row.querySelectorAll("input[name],select[name]");
    const names = new Set([...fields].map((field) => field.name));
    const now = new FormData(form);
    if (
      [...names].some(
        (name) => (now.get(name) ?? "") !== (saved.get(name) ?? ""),
      )
    )
      count++;
  }
  return count;
};
for (const form of forms) {
  const button = form.querySelector("[data-permissions-save]");
  const status = form.querySelector("[data-permissions-status]");
  const setState = (state, label, icon) => {
    button.dataset.state = state;
    button.querySelector("[data-feedback-label]").textContent = label;
    button.querySelector("[data-feedback-icon]").textContent = icon;
  };
  const say = (text, kind = "info") => {
    status.dataset.kind = kind;
    status.setAttribute("role", kind === "error" ? "alert" : "status");
    status.textContent = text;
  };
  const refresh = () => {
    const count = dirtyCount(form);
    form.dataset.dirty = count ? "true" : "";
    if (button.dataset.state !== "loading")
      say(
        count === 0
          ? "Sin cambios pendientes."
          : count === 1
            ? "1 permiso sin guardar."
            : `${count} permisos sin guardar.`,
      );
  };
  // A bulk selector shows the state of its rows and, when changed, sets them all.
  const scopeRows = (select) => {
    const scope = select.closest("[data-permission-scope]");
    return scope.matches("[data-permission-group]")
      ? scope.querySelectorAll("[data-permission-row]")
      : form.querySelectorAll("[data-permission-row]");
  };
  const showBulk = () => {
    for (const select of form.querySelectorAll("[data-bulk]")) {
      const values = new Set(
        [...scopeRows(select)].map(
          (row) => row.querySelector("input[type=radio]:checked")?.value,
        ),
      );
      select.value = values.size === 1 ? [...values][0] : "mixed";
      select.dataset.state = select.value;
    }
  };
  form.dataset.saved = snapshot(form);
  showBulk();
  form.addEventListener("change", (event) => {
    const bulk = event.target.closest("[data-bulk]");
    if (bulk)
      for (const row of scopeRows(bulk)) {
        const radio = row.querySelector(
          `input[type=radio][value="${bulk.value}"]`,
        );
        if (radio) radio.checked = true;
      }
    showBulk();
    refresh();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    setState("loading", "Guardando…", "");
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams(new FormData(form)),
        credentials: "same-origin",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw Error(
          result.error ||
            "La aplicación no respondió correctamente. Reintentá; si sigue fallando, volvé a abrir Nemein.",
        );
      form.dataset.saved = snapshot(form);
      form.dataset.dirty = "";
      setState("prepared", "Guardados", "✓");
      say(
        result.changed
          ? `Permisos guardados: ${result.changed} ${result.changed === 1 ? "cambio" : "cambios"} para ${form.dataset.connectionLabel}. Rigen desde su próximo pedido.`
          : "Los permisos ya estaban al día.",
      );
      setTimeout(() => {
        setState("idle", "Guardar permisos", "");
        button.disabled = false;
      }, 2500);
    } catch (error) {
      setState("error", "Reintentar", "!");
      say(`No se guardó ningún permiso: ${error.message}`, "error");
      button.disabled = false;
    } finally {
      button.setAttribute("aria-busy", "false");
    }
  });
}
window.addEventListener("beforeunload", (event) => {
  if ([...forms].some((form) => form.dataset.dirty)) event.preventDefault();
});
