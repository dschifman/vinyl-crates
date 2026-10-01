// app.js -- the Crates page: a search box, genre and style dropdowns, filter
// chips, and the song list.
// The whole catalog arrives once from /api/catalog and is searched here, in
// the browser (search.js). Everything shown is built with textContent, never
// innerHTML: catalog text is data, not markup.

import { buildIndex, search, FORMATS, FORMAT_LABELS, FORMAT_SHORT, FORMAT_BIT } from "./search.js";

const PAGE = 40;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");

const state = {
  snap: null,
  index: null,
  results: [],
  shown: 0,
  filters: { occasion: null, moment: null, bucket: null, style: null, decades: new Set(), formats: new Set() },
};

main();

async function main() {
  loadWho();
  let snap;
  try {
    const res = await fetch("/api/catalog", { headers: { Accept: "application/json" } });
    if (res.status === 503) return notice("The catalog isn't published yet. Please check back soon.");
    if (!res.ok) return notice(`Couldn't load the catalog (error ${res.status}). Reload the page to try again.`);
    snap = await res.json();
  } catch {
    return notice("Couldn't load the catalog. If this page has been open a while, reload it to sign in again.");
  }
  state.snap = snap;
  state.index = buildIndex(snap);

  const songs = snap.counts?.songs ?? snap.songs.length;
  const records = snap.counts?.releases ?? Object.keys(snap.releases).length;
  $("sub").textContent = `${fmt(songs)} songs on ${fmt(records)} records`;
  const q = $("q");
  q.placeholder = `Search ${fmt(songs)} songs…`;
  q.disabled = false;
  q.addEventListener("input", debounce(run, 90));
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") q.blur();          // put the phone keyboard away
  });
  $("clear").addEventListener("click", clearFilters);
  $("more").addEventListener("click", more);
  renderFilters();
  run();
}

async function loadWho() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return;
    const me = await res.json();
    if (me.email) $("who").textContent = `${me.email} · `;
    if (me.version) $("version").textContent = ` · Crates ${me.version}`;
  } catch {
    /* the footer simply stays shorter */
  }
}

function notice(message) {
  $("sub").textContent = "";
  const n = $("notice");
  n.textContent = message;
  n.hidden = false;
}

// ---------------------------------------------------------------- filters

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function chip(label, value, onClick) {
  const b = el("button", "chip", label);
  b.type = "button";
  b.dataset.value = String(value);
  b.setAttribute("aria-pressed", "false");
  b.addEventListener("click", () => onClick(b));
  return b;
}

function row(name) {
  const wrap = el("div", "row");
  const label = el("span", "row-label", name);
  const list = el("div", "chips");
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", name);
  wrap.append(label, list);
  return { wrap, list };
}

function multiRow(name, options, set) {
  const { wrap, list } = row(name);
  for (const [value, label] of options) {
    list.append(chip(label, value, (b) => {
      if (set.has(value)) set.delete(value);
      else set.add(value);
      b.setAttribute("aria-pressed", String(set.has(value)));
      run();
    }));
  }
  return wrap;
}

function syncSingle(list, value) {
  for (const b of list.children) b.setAttribute("aria-pressed", String(value != null && b.dataset.value === String(value)));
}

function renderMoments() {
  const box = $("moments");
  if (!box) return;
  const f = state.filters;
  const list = box.querySelector(".chips");
  list.replaceChildren();
  box.hidden = !f.occasion;
  if (!f.occasion) return;
  for (const m of state.index.occasionMoments[f.occasion] || []) {
    list.append(chip(m, m, () => {
      f.moment = f.moment === m ? null : m;
      syncSingle(list, f.moment);
      run();
    }));
  }
}

function option(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function picker(id, label) {
  const wrap = el("label", "picker");
  const sel = el("select");
  sel.id = id;
  sel.setAttribute("aria-label", label);
  wrap.append(sel);
  return { wrap, sel };
}

// Genre, then a style within it (the owner's pick, 2026-10-01), always in view.
function genreRow() {
  const { snap, index, filters: f } = state;
  const row = el("div", "pickers");
  const genre = picker("genre", "Genre");
  genre.sel.append(option("", "All genres"));
  for (const b of snap.buckets || []) {
    const n = index.bucketCounts.get(b);
    if (n) genre.sel.append(option(b, b));      // plain names: a count makes the closed box truncate on a phone
  }
  genre.sel.addEventListener("change", () => {
    f.bucket = genre.sel.value || null;
    f.style = null;
    fillStyles();
    run();
  });
  row.append(genre.wrap);
  if (index.styles.length) {
    const style = picker("style", "Style");
    style.sel.addEventListener("change", () => {
      f.style = style.sel.value === "" ? null : Number(style.sel.value);
      run();
    });
    row.append(style.wrap);
  } else {
    row.classList.add("single");                // a catalog from before api 5.63 has no styles
  }
  return row;
}

function fillStyles() {
  const sel = $("style");
  if (!sel) return;
  const f = state.filters;
  const list = f.bucket ? state.index.genreStyles.get(f.bucket) || [] : [];
  sel.replaceChildren(option("", f.bucket ? "All styles" : "Style"));
  for (const { id, name } of list) sel.append(option(String(id), name));    // biggest first
  sel.disabled = !list.length;
  sel.value = f.style == null ? "" : String(f.style);
}

function renderFilters() {
  const box = $("filters");
  const { snap, index, filters: f } = state;
  box.replaceChildren();
  box.append(genreRow());

  // Weddings and mitzvahs come next: they matter more than any decade or format.
  if (snap.occasions?.length) {
    const occ = row("Occasion");
    for (const o of snap.occasions) {
      occ.list.append(chip(o.name, o.name, () => {
        f.occasion = f.occasion === o.name ? null : o.name;
        f.moment = null;
        syncSingle(occ.list, f.occasion);
        renderMoments();
        run();
      }));
    }
    occ.wrap.classList.add("occasion");
    const moments = row("Moment");
    moments.wrap.id = "moments";
    moments.wrap.hidden = true;
    box.append(occ.wrap, moments.wrap);
  }

  // Decade and format fold away, so the songs start higher on a phone.
  const toggle = el("button", "toggle", "More filters");
  toggle.type = "button";
  toggle.id = "toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "more-filters");
  const extra = el("div", "extra");
  extra.id = "more-filters";
  extra.hidden = true;
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    extra.hidden = open;
  });
  extra.append(multiRow("Decade", index.decades.map(([d]) => [d, `${d}s`]), f.decades));
  let present = 0;
  for (const m of index.formatsOf) present |= m;
  const formats = FORMATS.filter((x) => present & FORMAT_BIT[x]);
  extra.append(multiRow("Format", formats.map((x) => [x, FORMAT_LABELS[x]]), f.formats));
  box.append(toggle, extra);
  fillStyles();
}

function syncToggle() {
  const f = state.filters;
  const n = f.decades.size + f.formats.size;
  const toggle = $("toggle");
  if (toggle) toggle.textContent = n ? `More filters · ${n} on` : "More filters";
}

function anyFilter() {
  const f = state.filters;
  return Boolean(f.occasion || f.moment || f.bucket || f.style != null || f.decades.size || f.formats.size);
}

function clearFilters() {
  const f = state.filters;
  f.occasion = null;
  f.moment = null;
  f.bucket = null;
  f.style = null;
  f.decades.clear();
  f.formats.clear();
  for (const b of $("filters").querySelectorAll(".chip")) b.setAttribute("aria-pressed", "false");
  $("genre").value = "";
  fillStyles();
  renderMoments();
  run();
}

// ---------------------------------------------------------------- results

function run() {
  state.results = search(state.index, $("q").value, state.filters);
  state.shown = 0;
  $("songs").replaceChildren();
  const n = state.results.length;
  $("count").textContent = `${fmt(n)} ${n === 1 ? "song" : "songs"}`;
  $("empty").hidden = n > 0;
  $("clear").hidden = !anyFilter();
  syncToggle();
  more();
}

let observer = null;

function more() {
  const list = $("songs");
  const end = Math.min(state.shown + PAGE, state.results.length);
  const frag = document.createDocumentFragment();
  for (let k = state.shown; k < end; k++) frag.append(songRow(state.results[k]));
  list.append(frag);
  state.shown = end;
  const button = $("more");
  button.hidden = end >= state.results.length;
  // Load the next page as the button scrolls into view; re-observing makes the
  // observer report at once if it is still in view after this page.
  if (!observer && "IntersectionObserver" in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !$("more").hidden) more();
    }, { rootMargin: "400px 0px" });
  }
  if (observer) {
    observer.unobserve(button);
    if (!button.hidden) observer.observe(button);
  }
}

function duration(secs) {
  const m = Math.floor(secs / 60);
  return `${m}:${String(secs % 60).padStart(2, "0")}`;
}

function youtube(s) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${s.a} ${s.t}`)}`;
}

function versionsList(s) {
  const ul = el("ul");
  for (const [rid, pos, mix, secs, credits] of s.v) {
    const r = state.snap.releases[String(rid)] || {};
    const li = el("li");
    li.append(el("strong", null, r.t || "Untitled record"));
    const bits = [];
    if (r.a && r.a !== s.a) bits.push(r.a);
    bits.push(FORMAT_SHORT[r.f] || "Other");
    if (r.py) bits.push(String(r.py));
    const label = [r.l, r.c].filter(Boolean).join(" ");
    if (label) bits.push(label);
    const side = String(pos || "").replace(/#\d+$/, "");
    if (side && !side.startsWith("#")) bits.push(side);
    if (mix) bits.push(mix);
    if (secs) bits.push(duration(secs));
    if (credits && credits.length) bits.push(`remix/edit: ${credits.join(", ")}`);
    li.append(document.createTextNode(` — ${bits.join(" · ")}`));
    ul.append(li);
  }
  return ul;
}

function songRow(i) {
  const s = state.index.songs[i];
  const li = el("li", "song");
  const head = el("button", "head");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");

  const line = el("span", "line");
  line.append(el("span", "t", s.t));
  if (s.y) line.append(el("span", "y", String(s.y)));
  head.append(line, el("span", "a", s.a));
  const n = s.v.length;
  const meta = [...(s.b || []), `${n} ${n === 1 ? "version" : "versions"}`];
  head.append(el("span", "meta", meta.join(" · ")));
  if (s.m && s.m.length) {
    const tags = el("span", "tags");
    for (const m of s.m) tags.append(el("span", "tag", m));
    head.append(tags);
  }

  const listen = el("a", "listen", "▶ Listen");
  listen.href = youtube(s);
  listen.target = "_blank";
  listen.rel = "noopener noreferrer";
  listen.setAttribute("aria-label", `Listen to ${s.t} by ${s.a} on YouTube`);

  const detail = el("div", "versions");
  detail.hidden = true;
  head.addEventListener("click", () => {
    const open = head.getAttribute("aria-expanded") === "true";
    if (!open && !detail.childElementCount) detail.append(versionsList(s));
    head.setAttribute("aria-expanded", String(!open));
    detail.hidden = open;
  });

  li.append(head, listen, detail);
  return li;
}

function debounce(fn, ms) {
  let t = 0;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
