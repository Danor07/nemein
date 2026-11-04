// The connectors screen (views/connectors.ejs). Files travel as base64 in
// JSON: the component to install, and the bank file a connector prepares.
// The server checks every limit again; these only spare a useless upload.
const COMPONENT_MAX = 16 * 1024 * 1024;
const SIGNATURE_MAX = 4096;
const INPUT_MAX = 5000000;

// The browser encodes the file itself: a data URL carries its bytes as
// base64 after the comma. Chromium answers an empty file with "data:".
const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] ?? "");
    reader.onerror = () =>
      reject(new Error("No se pudo leer el archivo. Volvé a seleccionarlo."));
    reader.readAsDataURL(file);
  });

async function post(action, body) {
  const response = await fetch("/action/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const answer = await response.json();
  if (!response.ok) throw new Error(answer.error);
  return answer;
}

// Disables the form while it works, and reports in its status line.
function handle(form, status, work) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      status.textContent = await work();
    } catch (e) {
      status.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  });
}

const install = document.querySelector("#connector-install-form");
if (install)
  handle(
    install,
    document.querySelector("#connector-install-status"),
    async () => {
      const component = document.querySelector("#connector-component").files[0];
      const signature = document.querySelector("#connector-signature").files[0];
      if (!component) return "Elegí el componente.";
      if (component.size > COMPONENT_MAX) return "El componente supera 16 MiB.";
      if (signature && signature.size > SIGNATURE_MAX)
        return "El archivo de firma supera 4 KiB: no es una firma de Nemein.";
      const { notice } = await post("connector-install", {
        _csrf: install.dataset.csrf,
        component_base64: await toBase64(component),
        ...(signature ? { signature: await signature.text() } : {}),
      });
      location.assign("/?view=connectors&notice=" + encodeURIComponent(notice));
      return notice;
    },
  );

const prepare = document.querySelector("#connector-prepare-form");
if (prepare)
  handle(
    prepare,
    document.querySelector("#connector-prepare-status"),
    async () => {
      const input = document.querySelector("#connector-input").files[0];
      if (!input) return "Elegí el archivo del banco.";
      if (input.size > INPUT_MAX) return "El archivo supera 5 MB.";
      const field = (name) => prepare.querySelector(`[name=${name}]`).value;
      const { id } = await post("connector-prepare", {
        _csrf: prepare.dataset.csrf,
        hash: field("hash"),
        account_id: field("account_id"),
        category_id: field("category_id"),
        config: field("config"),
        content_base64: await toBase64(input),
      });
      location.assign(
        "/?view=connectors&batch=" +
          encodeURIComponent(id) +
          "#connector-review",
      );
      return "Lote preparado. Abriendo la revisión…";
    },
  );
