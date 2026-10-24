const mcpForm = document.querySelector("[data-mcp-form]");
if (mcpForm) {
  const button = mcpForm.querySelector("[data-mcp-download]");
  const status = document.querySelector("#mcp-download-status");
  const setState = (state, label, icon) => {
    button.dataset.state = state;
    button.querySelector("[data-feedback-label]").textContent = label;
    button.querySelector("[data-feedback-icon]").textContent = icon;
  };
  mcpForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    setState("loading", "Preparando…", "");
    status.setAttribute("role", "status");
    status.dataset.kind = "info";
    status.textContent = "Preparando nemein-mcp.json…";
    let failure =
      "No se pudo preparar la configuración: la aplicación no respondió correctamente. Reintentá; si sigue fallando, volvé a abrir Nemein.";
    try {
      const response = await fetch(mcpForm.action, {
        method: "POST",
        body: new URLSearchParams(new FormData(mcpForm)),
        credentials: "same-origin",
      });
      if (response.status === 410)
        failure =
          "La descarga venció. Renová el token en Permisos y propuestas y descargá la configuración nueva.";
      if (!response.ok) throw Error("Configuration unavailable");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "nemein-mcp.json";
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      setState("prepared", "Preparada", "✓");
      status.textContent =
        "Configuración preparada: nemein-mcp.json. Se solicitó guardarla; suele quedar en Descargas. Si no aparece, usá «Ver configuración para copiar».";
      setTimeout(() => {
        setState("idle", "Descargar configuración MCP", "");
        button.disabled = false;
      }, 2500);
    } catch {
      setState("error", "Reintentar", "!");
      status.dataset.kind = "error";
      status.setAttribute("role", "alert");
      status.textContent = failure;
      button.disabled = false;
    } finally {
      button.setAttribute("aria-busy", "false");
    }
  });
}
