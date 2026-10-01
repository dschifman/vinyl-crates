// dj.js -- the DJ's view at /dj, for OWNER_EMAIL only (meta-repo docs/dj-client-catalog.md
// section 5.4): every gig's merged list with print and CSV, the gig's people and
// their lists, who may sign in, and the searches that found nothing. It talks only
// to /api/dj/* (src/dj.ts). Like the rest of the site it builds the page with
// textContent: names, titles and notes are data, not markup.

import { api } from "./api.js";
import { el, button, option, day, fmt, toast } from "./dom.js";
import { TIERS } from "./list.js";

const $ = (id) => document.getElementById(id);
const TIER_NAME = Object.fromEntries(TIERS.map((t) => [t.id, t.name]));
const ROLES = [["host", "Host"], ["planner", "Planner"], ["guest", "Guest"]];
const ROLE_NAME = Object.fromEntries(ROLES);
const STATUSES = [
  ["planning", "Planning: taking requests"],
  ["locked", "Locked: the list is final"],
  ["played", "Played"],
  ["archived", "Archived"],
];
const VIEWS = new Set(["gigs", "gig", "people", "searches"]);
const FORMULA =
  "Score = role weight × (tier points + rank bonus). Must play is 3 points and Would love 1; " +
  "the top of someone's tier adds 1.0, down to 1/n at the bottom. Hosts count in full, " +
  "planners × 0.75, guests × 0.25. A host's “please don't” takes a song off; a planner's flags it.";

let data = null;   // /api/dj/overview
let drawn = "";    // the view on screen: a refresh redraws it in place
let seq = 0;       // the latest draw; one that finishes after a newer one is dropped

main();

async function main() {
  window.addEventListener("hashchange", draw);
  api("GET", "/api/me")
    .then((me) => {
      $("who").textContent = `${me.email} · `;
      if (me.version) $("version").textContent = ` · Crates ${me.version}`;
    })
    .catch(() => {});
  await refresh();
}

async function refresh() {
  try {
    data = await api("GET", "/api/dj/overview");
  } catch (e) {
    $("dj").replaceChildren(el("p", "notice", e.message));
    return;
  }
  await draw();
}

function where() {
  const [name, raw] = location.hash.slice(1).split("=");
  let arg = null;
  try {
    arg = raw ? decodeURIComponent(raw) : null;
  } catch {
    arg = null;                     // a hash typed by hand
  }
  const view = VIEWS.has(name) && (name !== "gig" || arg) ? name : "gigs";
  return { view, arg: view === "gig" ? arg : null };
}

async function draw() {
  if (!data) return;
  const { view, arg } = where();
  const tab = view === "gig" ? "gigs" : view;
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.view === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const box = $("dj");
  const key = `${view}:${arg ?? ""}`;
  const fresh = key !== drawn;
  drawn = key;
  const mine = ++seq;
  let parts;
  if (view === "gig") {
    if (fresh) box.replaceChildren(el("p", "hint", "Loading…"));
    parts = await gigView(arg);
  } else if (view === "people") {
    parts = peopleView();
  } else if (view === "searches") {
    parts = searchesView();
  } else {
    parts = gigsView();
  }
  if (mine !== seq) return;
  box.replaceChildren(...parts);
  if (fresh) window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- small pieces

function input(type, value, attrs = {}) {
  const i = el("input");
  i.type = type;
  if (value != null) i.value = value;
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}

function field(label, control, wide = false) {
  const l = el("label", wide ? "field wide" : "field", label);
  l.append(control);
  return l;
}

function select(options, selected) {
  const s = el("select");
  for (const [value, label] of options) s.append(option(value, label, value === selected));
  return s;
}

function submit(label) {
  const b = el("button", "primary", label);
  b.type = "submit";
  return b;
}

function actions(...nodes) {
  const d = el("div", "actions");
  d.append(...nodes);
  return d;
}

// A form that calls the API: no page navigation (the CSP allows none), its buttons
// off while the call is out, and a refusal shown as the Worker worded it.
function onSubmit(form, fn) {
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const buttons = [...form.querySelectorAll("button")];
    for (const b of buttons) b.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  });
}

function act(label, className, fn) {
  const b = button(label, className, async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

// A button that opens `box` below its row with what `make` returns, or closes it.
function opener(label, box, make) {
  const b = button(label, "icon text", async () => {
    const open = !box.hidden && box.dataset.by === label;
    for (const other of b.parentElement.querySelectorAll("[aria-expanded]")) other.setAttribute("aria-expanded", "false");
    if (open) {
      box.hidden = true;
      return;
    }
    box.dataset.by = label;
    box.hidden = false;
    b.setAttribute("aria-expanded", "true");
    box.replaceChildren(el("p", "hint", "Loading…"));
    const parts = await make();
    if (box.dataset.by === label) box.replaceChildren(...parts);
  }, { "aria-expanded": "false" });
  return b;
}

const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const who = (e) => e.name || e.email;

// A date picked here means the end of that day, here.
function endOfDay(value) {
  return value ? new Date(`${value}T23:59:59`).toISOString() : null;
}

function localDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function statusText(g) {
  if (g.status === "planning") {
    if (!g.open) return `Requests closed ${day(g.requests_close_at, { year: false })}`;
    return g.requests_close_at ? `Taking requests until ${day(g.requests_close_at, { year: false })}` : "Taking requests";
  }
  return { locked: "Locked", played: "Played", archived: "Archived" }[g.status] ?? g.status;
}

function badge(inv) {
  if (!inv) return null;
  const add = inv.action === "add";
  if (inv.state === "failed") {
    return el("span", "badge warn", `${add ? "Invite" : "Removal"} failed${inv.error ? `: ${inv.error}` : ""}`);
  }
  if (inv.state === "applied") return el("span", add ? "badge ok" : "badge", add ? "Can sign in" : "Can't sign in");
  return el("span", "badge", add ? "Invite pending" : "Removal pending");
}

// ---------------------------------------------------------------- gigs

function gigsView() {
  const sec = el("section", "sec");
  sec.append(el("h2", null, "Gigs"), newGig());
  const byDate = (dir) => (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") * dir;
  const ahead = data.gigs.filter((g) => g.status === "planning" || g.status === "locked").sort(byDate(1));
  const played = data.gigs.filter((g) => g.status === "played").sort(byDate(-1));
  const archived = data.gigs.filter((g) => g.status === "archived");
  if (!data.gigs.length) {
    sec.append(el("p", "hint", "No gigs yet. Create one, then add its hosts and planner: each signs in with their own email."));
  }
  if (ahead.length) sec.append(cards(ahead));
  if (played.length) sec.append(el("h3", "subhead", "Played"), cards(played));
  if (archived.length) {
    const d = el("details", "fold");
    d.append(el("summary", null, `Archived · ${archived.length}`), cards(archived));
    sec.append(d);
  }
  return [sec];
}

function cards(gigs) {
  const ul = el("ul", "cards");
  for (const g of gigs) {
    const li = el("li", "card");
    const a = el("a");
    a.href = `#gig=${g.id}`;
    const line = el("span", "line");
    line.append(el("span", "t", g.name));
    if (g.date) line.append(el("span", "y", day(g.date)));
    a.append(line, el("span", "a", [g.venue, statusText(g)].filter(Boolean).join(" · ")));
    const c = g.counts || {};
    const bits = [g.members.length ? g.members.map(who).join(", ") : "Nobody added yet"];
    bits.push(`${c.must || 0} must`, `${c.want || 0} would love`);
    if (c.dnp) bits.push(`${c.dnp} don't`);
    if (c.wish) bits.push(plural(c.wish, "wish", "wishes"));
    a.append(el("span", "meta", bits.join(" · ")));
    li.append(a);
    ul.append(li);
  }
  return ul;
}

function newGig() {
  const d = el("details", "fold");
  d.append(el("summary", null, "+ New gig"));
  d.append(gigForm(null, "Create the gig", async (body) => {
    const out = await api("POST", "/api/dj/gigs", body);
    toast("Gig created. Now add its people.", "ok");
    data = await api("GET", "/api/dj/overview");
    location.hash = `#gig=${out.gig.id}`;
  }));
  return d;
}

// The same form makes a gig and edits one. Editing sends only what changed, so a
// close time set elsewhere isn't rounded to the end of a day by saving the name.
function gigForm(g, label, send) {
  const f = el("form", "form");
  const name = input("text", g?.name ?? "", { required: "", maxlength: "120", autocomplete: "off" });
  const date = input("date", g?.date ?? "");
  const venue = input("text", g?.venue ?? "", { maxlength: "160", autocomplete: "off" });
  const close = input("date", localDate(g?.requests_close_at));
  const cap = input("number", String(g?.must_cap ?? 20), { min: "1", max: "200", step: "1", inputmode: "numeric" });
  f.append(field("Name", name, true), field("Date", date), field("Venue", venue), field("Requests close", close),
    field("Must-plays each", cap));
  const status = g ? select(STATUSES, g.status) : null;
  if (status) f.append(field("Status", status));
  f.append(actions(submit(label)));
  onSubmit(f, async () => {
    const body = {
      name: name.value,
      date: date.value || null,
      venue: venue.value || null,
      requests_close_at: endOfDay(close.value),
      must_cap: cap.value === "" ? 20 : Number(cap.value),
    };
    if (status) body.status = status.value;
    if (g) {
      if (close.value === localDate(g.requests_close_at)) delete body.requests_close_at;
      for (const k of ["name", "date", "venue", "must_cap", "status"]) if (body[k] === (g[k] ?? null)) delete body[k];
      if (!Object.keys(body).length) return toast("Nothing changed.", "ok");
    }
    await send(body);
  });
  return f;
}

async function gigView(id) {
  const back = el("a", "back", "‹ All gigs");
  back.href = "#gigs";
  const g = data.gigs.find((x) => x.id === id);
  if (!g) return [back, el("p", "notice", "That gig isn't here any more.")];
  let merged;
  try {
    merged = await api("GET", `/api/dj/gigs/${encodeURIComponent(id)}/merged`);
  } catch (e) {
    return [back, el("p", "notice", e.message)];
  }
  return [back, gigHead(g), mergedSection(g, merged), membersSection(g), editSection(g)];
}

function gigHead(g) {
  const head = el("div", "gighead");
  head.append(el("h2", null, g.name));
  const when = [day(g.date), g.venue].filter(Boolean).join(" · ");
  if (when) head.append(el("p", "when", when));
  const line = [statusText(g), `${g.must_cap} must-plays each`];
  if (g.status === "planning" && !g.open) line.push("move the close date in Edit to reopen");
  head.append(el("p", "liststatus", line.join(" · ")));
  const set = (status, label, done) => act(label, "quiet", async () => {
    await api("PATCH", `/api/dj/gigs/${g.id}`, { status });
    toast(done, "ok");
    await refresh();
  });
  const bar = actions();
  bar.classList.add("noprint");
  if (g.status === "planning") bar.append(set("locked", "Lock the list", "Locked. Nobody can change their list now."));
  if (g.status === "locked") {
    bar.append(set("planning", "Reopen requests", "Reopened."), set("played", "Mark played", "Marked played."));
  }
  if (g.status === "played") bar.append(set("archived", "Archive", "Archived."));
  if (g.status === "archived") bar.append(set("played", "Unarchive", "Back among the played gigs."));
  head.append(bar);
  return head;
}

function editSection(g) {
  const d = el("details", "sec fold noprint");
  d.append(el("summary", null, "Edit the gig"));
  d.append(gigForm(g, "Save", async (body) => {
    await api("PATCH", `/api/dj/gigs/${g.id}`, body);
    toast("Saved.", "ok");
    await refresh();
  }));
  return d;
}

// ---------------------------------------------------------------- the merged list

function mergedSection(g, m) {
  const sec = el("section", "sec merged");
  const head = el("div", "sechead");
  head.append(el("h3", null, `The merged list · ${plural(m.songs.length, "song", "songs")}`));
  const csv = el("a", "quiet", "CSV");
  csv.href = `/api/dj/gigs/${g.id}/merged.csv`;
  csv.setAttribute("download", "");
  const tools = el("div", "tools noprint");
  tools.append(button("Print", "quiet", () => window.print()), csv);
  head.append(tools);
  sec.append(head, el("p", "hint noprint", FORMULA));
  if (!m.songs.length) sec.append(el("p", "emptytier", "Nothing requested yet. People add songs from the crates with ⊕."));
  const ol = el("ol", "mlist");
  m.songs.forEach((s, i) => ol.append(mergedSong(s, i + 1)));
  sec.append(ol);
  if (m.vetoed.length) {
    sec.append(el("h4", null, "Vetoed by a host"));
    const v = el("ol", "mlist");
    for (const s of m.vetoed) v.append(mergedSong(s, null));
    sec.append(v);
  }
  if (m.dnp.length) {
    sec.append(el("h4", null, "Please don't play"));
    const ul = el("ul", "mlist");
    for (const s of m.dnp) ul.append(saidBy(s, (e) => `${who(e)} (${ROLE_NAME[e.role].toLowerCase()})`));
    sec.append(ul);
  }
  if (m.wishes.length) {
    sec.append(el("h4", null, "Wishes: not in the crates"));
    const ul = el("ul", "mlist");
    for (const w of m.wishes) ul.append(saidBy(w, who));
    sec.append(ul);
  }
  return sec;
}

function mergedSong(s, rank) {
  const li = el("li", "msong");
  li.append(el("span", "rank", rank ? String(rank) : "–"));
  const body = el("div", "body");
  body.append(el("div", "t", s.title), el("div", "a", s.artist));
  if (s.flagged) body.append(el("span", "badge warn", "A planner said please don't"));
  body.append(el("div", "who", s.entries.map((e) => `${who(e)}: ${TIER_NAME[e.tier]} #${e.rank} of ${e.of}`).join(" · ")));
  const moments = [...new Set(s.entries.map((e) => e.moment).filter(Boolean))];
  if (moments.length) body.append(el("div", "meta", `Moment: ${moments.join(", ")}`));
  const versions = new Map();
  for (const e of s.entries) if (e.version_key && !versions.has(e.version_key)) versions.set(e.version_key, e.mix);
  if (versions.size) body.append(versionLine(versions));
  for (const e of s.entries) if (e.note) body.append(el("div", "note", `${who(e)}: “${e.note}”`));
  li.append(body, el("span", "score", s.score.toFixed(2)));
  return li;
}

// "Version: Club Mix (A2)" -- each one links to its record on Discogs.
function versionLine(versions) {
  const line = el("div", "meta", "Version: ");
  let first = true;
  for (const [key, mix] of versions) {
    const [rid, pos] = key.split(":");
    if (!first) line.append(", ");
    first = false;
    const a = el("a", null, mix ? `${mix} (${pos})` : pos);
    a.href = `https://www.discogs.com/release/${encodeURIComponent(rid)}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    line.append(a);
  }
  return line;
}

function saidBy(s, label) {
  const li = el("li", "msong");
  li.append(el("span", "rank", "–"));
  const body = el("div", "body");
  body.append(el("div", "t", s.title));
  if (s.artist) body.append(el("div", "a", s.artist));
  body.append(el("div", "who", s.entries.map(label).join(" · ")));
  for (const e of s.entries) if (e.note) body.append(el("div", "note", `${who(e)}: “${e.note}”`));
  li.append(body);
  return li;
}

// ---------------------------------------------------------------- people

function membersSection(g) {
  const sec = el("section", "sec noprint");
  sec.append(el("h3", null, `People · ${g.members.length}`));
  sec.append(el("p", "hint", "Each signs in with their own email and keeps their own list. Hosts count in full, planners × 0.75, guests × 0.25."));
  const ul = el("ul", "people");
  for (const m of g.members) {
    const li = el("li", "person");
    const body = el("div", "body");
    body.append(el("div", "t", who(m)));
    body.append(el("div", "a", [m.name ? m.email : null, ROLE_NAME[m.role]].filter(Boolean).join(" · ")));
    const b = badge(m.invite);
    if (b) body.append(b);
    const extra = el("div", "extra");
    extra.hidden = true;
    const ctl = el("div", "ctl");
    ctl.append(
      opener("List", extra, () => personList(m.email, g.id)),
      act("Remove", "icon text", async () => {
        if (!confirm(`Take ${who(m)} off ${g.name}? Their requests for it leave the merged list.`)) return;
        await api("DELETE", `/api/dj/gigs/${g.id}/members/${encodeURIComponent(m.email)}`);
        toast(`${who(m)} is off the gig.`, "ok");
        await refresh();
      }),
    );
    li.append(body, ctl, extra);
    ul.append(li);
  }
  sec.append(ul, memberForm(g.id, null));
  return sec;
}

// Add someone to a gig. From People, the email is already known: a prospect whose own
// list becomes the gig's.
function memberForm(gigId, email) {
  const f = el("form", "form");
  let gig = null;
  let address = null;
  if (gigId === null) {
    const open = data.gigs.filter((g) => g.status === "planning" || g.status === "locked")
      .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    if (!open.length) return el("p", "hint", "No gig to add them to yet. Create one under Gigs first.");
    gig = select(open.map((g) => [g.id, [g.name, day(g.date, { year: false })].filter(Boolean).join(" · ")]));
    f.append(field("Gig", gig, true));
  } else {
    address = input("email", "", { required: "", maxlength: "254", autocomplete: "off", placeholder: "name@example.com" });
    f.append(field("Email", address, true));
  }
  const name = input("text", "", { maxlength: "120", autocomplete: "off" });
  const role = select(ROLES, "host");
  f.append(field("Name", name), field("Role", role), actions(submit("Add to the gig")));
  onSubmit(f, async () => {
    const id = gigId ?? gig.value;
    const out = await api("POST", `/api/dj/gigs/${id}/members`, {
      email: email ?? address.value, name: name.value || null, role: role.value,
    });
    if (out.moved) toast(`Added. Their list (${plural(out.moved, "song", "songs")}) is now the gig's.`, "ok");
    else if (out.kept_own_list) toast(`Added. They already had songs on this gig, so their other ${plural(out.kept_own_list, "song stays", "songs stay")} on their own list.`, "ok");
    else toast("Added to the gig.", "ok");
    await refresh();
  });
  return f;
}

async function personList(email, gigId) {
  const q = new URLSearchParams({ email });
  if (gigId) q.set("gig", gigId);
  try {
    return listParts((await api("GET", `/api/dj/list?${q}`)).mine);
  } catch (e) {
    return [el("p", "notice", e.message)];
  }
}

function listParts(rows) {
  if (!rows.length) return [el("p", "emptytier", "Nothing on this list yet.")];
  const out = [];
  for (const t of TIERS) {
    const rs = rows.filter((r) => r.tier === t.id);
    if (!rs.length) continue;
    out.push(el("h4", null, `${t.name} · ${rs.length}`));
    const ol = el("ol", "reqs");
    rs.forEach((r, i) => {
      const li = el("li", "req");
      li.append(el("span", "rank", String(i + 1)));
      const body = el("div", "body");
      body.append(el("div", "t", r.title));
      const sub = [r.artist, r.mix].filter(Boolean).join(" · ");
      if (sub) body.append(el("div", "a", sub));
      if (r.moment) body.append(el("div", "meta", `Moment: ${r.moment}`));
      if (r.note) body.append(el("div", "note", r.note));
      li.append(body);
      ol.append(li);
    });
    out.push(ol);
  }
  return out;
}

function peopleView() {
  const own = el("section", "sec");
  own.append(el("h2", null, "Lists before a booking"));
  own.append(el("p", "hint", "People who started a list before you booked them. Add one to a gig and their list becomes the gig's."));
  if (!data.prospects.length) own.append(el("p", "emptytier", "Nobody yet."));
  const ul = el("ul", "people");
  for (const p of data.prospects) {
    const li = el("li", "person");
    const body = el("div", "body");
    body.append(el("div", "t", p.email), el("div", "a", `${plural(p.n, "song", "songs")} · changed ${day(p.updated_at, { year: false })}`));
    const b = badge(p.invite);
    if (b) body.append(b);
    const extra = el("div", "extra");
    extra.hidden = true;
    const ctl = el("div", "ctl");
    ctl.append(opener("List", extra, () => personList(p.email, null)), opener("Add to a gig", extra, () => [memberForm(null, p.email)]));
    li.append(body, ctl, extra);
    ul.append(li);
  }
  own.append(ul);

  const access = el("section", "sec");
  access.append(el("h2", null, "Who can sign in"));
  access.append(el("p", "hint",
    "Invites and removals made here. The Living Room mini applies them to Cloudflare Access within a couple of " +
    "minutes; a removal also signs that person out everywhere. People you added on the mini itself aren't listed."));
  const f = el("form", "form");
  const email = input("email", "", { required: "", maxlength: "254", autocomplete: "off", placeholder: "name@example.com" });
  f.append(field("Invite someone to browse", email, true), actions(submit("Invite")));
  onSubmit(f, async () => {
    await api("POST", "/api/dj/invites", { email: email.value });
    toast("Invited. They can sign in once the Living Room mini applies it.", "ok");
    await refresh();
  });
  access.append(f);
  const list = el("ul", "people");
  for (const i of data.invites) {
    const li = el("li", "person");
    const body = el("div", "body");
    body.append(el("div", "t", i.email), badge(i));
    if (i.updated_at) body.append(el("div", "a", `changed ${day(i.updated_at, { year: false })}`));
    const ctl = el("div", "ctl");
    if (i.action === "add") {
      ctl.append(act("Revoke", "icon text", async () => {
        if (!confirm(`Stop ${i.email} signing in? They are signed out everywhere, too.`)) return;
        await api("POST", "/api/dj/access/remove", { email: i.email });
        toast("Removal queued for the Living Room mini.", "ok");
        await refresh();
      }));
    } else {
      ctl.append(act("Invite again", "icon text", async () => {
        await api("POST", "/api/dj/invites", { email: i.email });
        toast("Invited again.", "ok");
        await refresh();
      }));
    }
    li.append(body, ctl);
    list.append(li);
  }
  access.append(list);
  return [own, access];
}

// ---------------------------------------------------------------- searches

function searchesView() {
  const sec = el("section", "sec");
  sec.append(el("h2", null, "Searches that found nothing"));
  sec.append(el("p", "hint",
    "What people typed in the last 90 days that matched no song, most often first. No names are kept: " +
    "it's a shopping list for the crates."));
  if (!data.misses.length) {
    sec.append(el("p", "emptytier", "None yet."));
    return [sec];
  }
  const table = el("table", "plain");
  const head = el("tr");
  head.append(el("th", null, "Search"), el("th", "num", "Times"), el("th", null, "Last"));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  for (const m of data.misses) {
    const tr = el("tr");
    tr.append(el("td", null, m.q), el("td", "num", fmt(m.n)), el("td", null, day(m.last, { year: false })));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  sec.append(table);
  return [sec];
}
