const dialog = document.querySelector('#confirm-dialog');
document.querySelectorAll('[data-confirm]').forEach(form => form.addEventListener('submit', e => {
  if(form.dataset.confirmed === 'yes') return;
  e.preventDefault();
  document.querySelector('#confirm-message').textContent = form.dataset.confirm;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  dialog.addEventListener('close', () => {
    if(dialog.returnValue === 'confirm') { form.dataset.confirmed = 'yes'; form.requestSubmit(); }
  }, {once:true});
}));
document
  .querySelector("[data-back]")
  ?.addEventListener("click", () => history.back());
const payee = document.querySelector("#quick-entry [name=payee]");
payee?.addEventListener("change", () => {
  const match = [...document.querySelectorAll("#payees option")].find(
    (o) => o.value === payee.value.trim().toLocaleLowerCase("es"),
  );
  if (match)
    document.querySelector("#entry-category").value = match.dataset.category;
});
const file = document.querySelector("#csv-file"),
  separator = document.querySelector("#csv-delimiter");
let csvText = "";
function headers(text, sep) {
  const fields = [];
  let value = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && ch === sep) {
      fields.push(value);
      value = "";
    } else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else value += ch;
  }
  fields.push(value);
  return fields;
}
function refresh() {
  const cols = headers(csvText.replace(/^\uFEFF/, ""), separator.value);
  document.querySelectorAll("[data-csv-column]").forEach((select) => {
    select.replaceChildren(new Option("Elegí una columna", ""));
    cols.forEach((col) => select.add(new Option(col, col)));
    select.value = select.dataset.saved || "";
  });
}
file?.addEventListener("change", async () => {
  const f = file.files[0];
  if (!f) return;
  if (f.size > 5e6) {
    file.value = "";
    document.querySelector("#csv-message").textContent =
      "El archivo supera 5 MB.";
    return;
  }
  csvText = await f.text();
  document.querySelector("#csv-content").value = csvText;
  refresh();
  document.querySelector("#csv-message").textContent =
    "Archivo leído. Revisá el mapeo antes de continuar.";
});
separator?.addEventListener("change", refresh);
const report = document.querySelector("#report-data");
if (report && typeof Chart !== "undefined") {
  const data = JSON.parse(report.dataset.json);
  const gs = (v) => "Gs. " + new Intl.NumberFormat("es-PY").format(v);
  Chart.defaults.font.family = '"Segoe UI", system-ui, sans-serif';
  Chart.defaults.color = "#758373";
  new Chart(document.querySelector("#spending-chart"), {
    type: "bar",
    data: {
      labels: data.spending.map((x) => x.name),
      datasets: [
        {
          data: data.spending.map((x) => x.amount),
          backgroundColor: "#719665",
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => gs(c.raw) } },
      },
      scales: {
        x: { grid: { color: "#edf1e9" }, ticks: { callback: (v) => gs(v) } },
        y: { grid: { display: false } },
      },
    },
  });
  new Chart(document.querySelector("#worth-chart"), {
    type: "line",
    data: {
      labels: data.history.map((x) => x.month),
      datasets: [
        {
          data: data.history.map((x) => x.value),
          borderColor: "#386e4e",
          backgroundColor: "#edf3e8",
          fill: true,
          tension: 0.25,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => gs(c.raw) } },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: "#edf1e9" }, ticks: { callback: (v) => gs(v) } },
      },
    },
  });
}
document.querySelectorAll('.table-wrap table').forEach(table => {
  const labels = [...table.querySelectorAll('thead th')].map(th => th.textContent);
  table.querySelectorAll('tbody tr:not(.group),tfoot tr').forEach(row => [...row.querySelectorAll('td')].forEach((td,i) => td.dataset.label = labels[i] || ''));
});

// WebView downloads can finish without showing browser download UI.
document.querySelector("[data-mcp-download]")?.addEventListener("click", () => {
  document.querySelector("#mcp-download-status").textContent =
    "Descarga solicitada. Buscá nemein-mcp.json en Descargas; puede aparecer con un número.";
});