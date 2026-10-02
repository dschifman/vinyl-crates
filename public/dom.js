// dom.js -- building the page. Every piece of text goes in with textContent, never
// innerHTML: catalog text and clients' notes are data, not markup.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function button(label, className, onClick, attrs = {}) {
  const b = el("button", className, label);
  b.type = "button";
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

export function option(value, label, selected = false) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  return o;
}

export const fmt = (n) => Number(n).toLocaleString("en-US");

// "2026-11-14" -> "Sat 14 Nov 2026"; an ISO instant -> the same, in local time.
export function day(value, { year = true } = {}) {
  if (!value) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
}

let toastTimer = 0;
export function toast(message, kind = "error") {
  let t = document.getElementById("toast");
  if (!t) {
    t = el("div", "toast");
    t.id = "toast";
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    document.body.append(t);
  }
  t.textContent = message;
  t.dataset.kind = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "error" ? 6000 : 2500);
}
