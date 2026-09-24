/*
 * TEMPORARY dev-only helper (deleted after the check).
 *
 * Drives a headless Chrome over the DevTools Protocol to read the result of
 * smoke.html. Needed because `--virtual-time-budget` never settles while a 34 MB WASM
 * runtime is initialising, so the page's own polling loop has to tell us when it is
 * done instead.
 */
const WebSocket = require("ws");

const TARGET_URL = process.env.SMOKE_URL || "http://localhost:5199/smoke.html";
const DEBUGGER_URL = "http://127.0.0.1:9222";

const POLL_EXPRESSION = `
new Promise((resolve) => {
  const deadline = Date.now() + 120000;
  const tick = setInterval(() => {
    const el = document.getElementById("out");
    const text = el ? el.textContent : "";
    if (/RESULT/.test(text) || Date.now() > deadline) {
      clearInterval(tick);
      resolve(text || "TIMEOUT: page produced nothing");
    }
  }, 500);
});
`;

async function main() {
  const targets = await (await fetch(`${DEBUGGER_URL}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target exposed by Chrome");

  const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  const pending = new Map();
  let nextId = 0;

  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1);
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await new Promise((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: TARGET_URL });

  const evaluated = await send("Runtime.evaluate", {
    expression: POLL_EXPRESSION,
    awaitPromise: true,
    returnByValue: true,
  });

  console.log(evaluated.result.value);
  socket.close();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("CDP driver failed:", error.message);
    process.exit(1);
  });
