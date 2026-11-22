(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), ctx = $("ctx"), text = $("text"), send = $("send"), stop = $("stop"), undo = $("undo"), status = $("status"), model = $("model");
  let current = null; // streaming assistant element

  const add = (cls, content) => { const d = document.createElement("div"); d.className = "msg " + cls; d.textContent = content; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  const setRunning = (r) => { send.disabled = r; stop.disabled = !r; };

  send.onclick = () => { const t = text.value.trim(); if (!t) return; vscode.postMessage({ type: "send", text: t }); text.value = ""; };
  stop.onclick = () => vscode.postMessage({ type: "stop" });
  undo.onclick = () => vscode.postMessage({ type: "undo" });
  model.onchange = () => vscode.postMessage({ type: "model", model: model.value });
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send.click(); } });

  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "models": model.innerHTML = ""; for (const x of m.models) { const o = document.createElement("option"); o.value = o.textContent = x; if (x === m.current) o.selected = true; model.appendChild(o); } break;
      case "user": add("user", "You: " + m.text); current = null; ctx.innerHTML = ""; break;
      case "delta": if (!current) current = add("assistant", ""); current.textContent += m.text; log.scrollTop = log.scrollHeight; break;
      case "toolCall": current = null; add("tool", "→ " + m.name + " " + JSON.stringify(m.args).slice(0, 160)); break;
      case "toolResult": add("tool", "← " + m.name + ": " + String(m.text).split("\n")[0].slice(0, 160)); break;
      case "notice": add("notice", m.text); break;
      case "status": status.textContent = m.status + (m.detail ? ": " + m.detail : ""); status.className = m.status; setRunning(m.status === "running" || m.status === "paused"); if (m.status === "done" || m.status === "cancelled" || m.status === "error") current = null; break;
      case "activity": for (const f of m.files || []) { const li = document.createElement("li"); li.textContent = f.path; if (f.why) { const w = document.createElement("span"); w.className = "why"; w.textContent = " — " + f.why; li.appendChild(w); } ctx.appendChild(li); } break;
      case "undoState": undo.disabled = !(m.size > 0); break;
    }
  });
})();
