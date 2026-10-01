// list.js -- a client's request list (Phase 3): Must play, Would love, Please
// don't play and Wishes, in their order. Everything goes through the Worker
// (api.js); after each change the list is redrawn from what the Worker returned.

import { api } from "./api.js";
import { el, button, option, day, toast } from "./dom.js";

export const TIERS = [
  { id: "must", name: "Must play", hint: "The songs you can't do without." },
  { id: "want", name: "Would love", hint: "Play these if you can." },
  { id: "dnp", name: "Please don't play", hint: "Songs to skip, whatever anyone asks." },
  { id: "wish", name: "Wishes", hint: "Songs you couldn't find in the crates." },
];
const TIER_NAME = Object.fromEntries(TIERS.map((t) => [t.id, t.name]));

export function createLists(onChange) {
  const st = {
    me: null,          // /api/me
    key: null,         // the current list: a gig id, or "" for your own list
    list: null,        // /api/list for it
    bySong: new Map(), // song_key -> request, for the plus buttons
    editing: null,     // the request id whose editor is open
  };

  const listKey = (l) => (l.gig ? l.gig.id : "");
  const current = () => st.me?.lists.find((l) => listKey(l) === st.key) ?? null;

  function index() {
    st.bySong.clear();
    for (const r of st.list?.mine ?? []) if (r.song_key) st.bySong.set(r.song_key, r);
  }

  async function load() {
    st.list = await api("GET", `/api/list${st.key ? `?gig=${encodeURIComponent(st.key)}` : ""}`);
    index();
    onChange();
  }

  async function init(me) {
    st.me = me;
    // A gig still taking requests first, then any gig, then your own list.
    const pick = me.lists.find((l) => l.gig && l.open) ?? me.lists.find((l) => l.gig) ?? me.lists.find((l) => !l.gig);
    st.key = pick ? listKey(pick) : "";
    await load();
  }

  const open = () => Boolean(st.list?.list.open);
  const count = () => st.list?.mine.length ?? 0;
  const has = (songKey) => st.bySong.get(songKey);

  async function add(song, version) {
    const body = { gig: st.key || null, song_key: song.k, artist: song.a, title: song.t };
    if (version) Object.assign(body, { version_key: version.key, mix: version.mix || null });
    const out = await api("POST", "/api/requests", body);
    await load();
    if (!out.existed) toast(`Added to ${TIER_NAME[out.request.tier]}.`, "ok");
    else if (version) toast("Version chosen.", "ok");
    return out.request;
  }

  async function remove(id) {
    await api("DELETE", `/api/requests/${id}`);
    if (st.editing === id) st.editing = null;
    await load();
  }

  async function patch(id, change) {
    await api("PATCH", `/api/requests/${id}`, change);
    await load();
  }

  async function move(r, delta) {
    const tier = st.list.mine.filter((x) => x.tier === r.tier);
    const i = tier.findIndex((x) => x.id === r.id);
    const j = i + delta;
    if (j < 0 || j >= tier.length) return;
    [tier[i], tier[j]] = [tier[j], tier[i]];
    await api("POST", "/api/requests/reorder", { gig: st.key || null, tier: r.tier, ids: tier.map((x) => x.id) });
    await load();
  }

  async function wish(artist, title, note) {
    await api("POST", "/api/requests", { gig: st.key || null, tier: "wish", artist, title, note });
    await load();
    toast("Added to Wishes.", "ok");
  }

  // ---------------------------------------------------------------- drawing

  function guard(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        toast(e.message);
      }
    };
  }

  function title() {
    const l = st.list.list;
    if (!l.gig) return "Your list";
    return [l.gig.name, day(l.gig.date)].filter(Boolean).join(" · ");
  }

  function status() {
    const l = st.list.list;
    const must = st.list.mine.filter((r) => r.tier === "must").length;
    if (!l.open) return l.gig?.status === "planning" ? "Requests are closed. Ask your DJ to reopen them." : "This list is final.";
    const bits = [];
    if (l.gig?.requests_close_at) bits.push(`Requests close ${day(l.gig.requests_close_at, { year: false })}`);
    bits.push(`${must} of ${l.must_cap} must-plays`);
    return bits.join(" · ");
  }

  function editor(r) {
    const box = el("div", "editor");
    let tierSel = null;
    if (r.tier !== "wish") {
      const label = el("label", "field", "List ");
      tierSel = el("select");
      for (const t of TIERS.filter((t) => t.id !== "wish")) tierSel.append(option(t.id, t.name, t.id === r.tier));
      label.append(tierSel);
      box.append(label);
    }
    const mLabel = el("label", "field", "Moment ");
    const mSel = el("select");
    mSel.append(option("", "None", !r.moment));
    for (const m of st.me.moments) mSel.append(option(m, m, m === r.moment));
    mLabel.append(mSel);
    const nLabel = el("label", "field wide", "Note for the DJ");
    const note = el("textarea");
    note.rows = 2;
    note.maxLength = 500;
    note.value = r.note ?? "";
    nLabel.append(note);
    const actions = el("div", "actions");
    actions.append(
      button("Save", "primary", guard(async () => {
        const change = { moment: mSel.value || null, note: note.value };
        if (tierSel && tierSel.value !== r.tier) change.tier = tierSel.value;
        st.editing = null;
        await patch(r.id, change);
      })),
      button("Cancel", "quiet", () => {
        st.editing = null;
        onChange();
      }),
      button("Remove", "danger", guard(() => remove(r.id))),
    );
    box.append(mLabel, nLabel, actions);
    return box;
  }

  function item(r, i, n, editable) {
    const li = el("li", "req");
    li.append(el("span", "rank", String(i + 1)));
    const body = el("div", "body");
    body.append(el("div", "t", r.title));
    const sub = [r.artist, r.mix].filter(Boolean).join(" · ");
    if (sub) body.append(el("div", "a", sub));
    const meta = [];
    if (r.moment) meta.push(`Moment: ${r.moment}`);
    if (meta.length) body.append(el("div", "meta", meta.join(" · ")));
    if (r.note) body.append(el("div", "note", r.note));
    li.append(body);
    if (editable) {
      const ctl = el("div", "ctl");
      if (r.tier !== "wish") {
        const up = button("▲", "icon", guard(() => move(r, -1)), { "aria-label": `Move ${r.title} up` });
        const down = button("▼", "icon", guard(() => move(r, 1)), { "aria-label": `Move ${r.title} down` });
        up.disabled = i === 0;
        down.disabled = i === n - 1;
        ctl.append(up, down);
      }
      ctl.append(button("Edit", "icon text", () => {
        st.editing = st.editing === r.id ? null : r.id;
        onChange();
      }, { "aria-expanded": String(st.editing === r.id) }));
      li.append(ctl);
      if (st.editing === r.id) li.append(editor(r));
    }
    return li;
  }

  function wishForm() {
    const form = el("form", "wishform");
    form.hidden = true;
    const artist = el("input");
    artist.placeholder = "Artist";
    artist.maxLength = 200;
    const t = el("input");
    t.placeholder = "Song title";
    t.maxLength = 200;
    t.required = true;
    const note = el("input");
    note.placeholder = "Note (optional)";
    note.maxLength = 500;
    const go = el("button", "primary", "Add wish");
    go.type = "submit";
    form.append(artist, t, note, go);
    form.addEventListener("submit", guard(async (ev) => {
      ev.preventDefault();
      await wish(artist.value, t.value, note.value);
    }));
    const toggle = button("+ Add a song you didn't find", "linkish", () => {
      form.hidden = !form.hidden;
      if (!form.hidden) artist.focus();
    });
    return [toggle, form];
  }

  function render(box) {
    box.replaceChildren();
    if (!st.list) return;
    const editable = open();
    const head = el("div", "listhead");
    head.append(el("h2", null, title()));
    if (st.me.lists.length > 1) {
      const pick = el("select", "listpick");
      pick.setAttribute("aria-label", "Which list");
      for (const l of st.me.lists) {
        const name = l.gig ? [l.gig.name, day(l.gig.date, { year: false })].filter(Boolean).join(" · ") : "Your own list";
        pick.append(option(listKey(l), name, listKey(l) === st.key));
      }
      pick.addEventListener("change", guard(async () => {
        st.key = pick.value;
        st.editing = null;
        await load();
      }));
      head.append(pick);
    }
    head.append(el("p", "liststatus", status()));
    box.append(head);

    for (const t of TIERS) {
      const rows = st.list.mine.filter((r) => r.tier === t.id);
      const sec = el("section", "tier");
      const h = el("h3", null, t.id === "must" ? `${t.name} · ${rows.length} of ${st.list.list.must_cap}` : t.name);
      sec.append(h, el("p", "hint", t.hint));
      if (rows.length) {
        const ol = el("ol", "reqs");
        rows.forEach((r, i) => ol.append(item(r, i, rows.length, editable)));
        sec.append(ol);
      } else if (t.id === "want") {
        sec.append(el("p", "emptytier", "Tap ⊕ next to a song in the crates to add it here."));
      }
      if (t.id === "wish" && editable) sec.append(...wishForm());
      box.append(sec);
    }

    for (const o of st.list.others ?? []) {
      const d = el("details", "other");
      const n = o.requests.length;
      d.append(el("summary", null, `${o.name || o.email}'s list · ${n} ${n === 1 ? "song" : "songs"}`));
      for (const t of TIERS) {
        const rows = o.requests.filter((r) => r.tier === t.id);
        if (!rows.length) continue;
        d.append(el("h4", null, t.name));
        const ol = el("ol", "reqs");
        rows.forEach((r, i) => ol.append(item(r, i, rows.length, false)));
        d.append(ol);
      }
      box.append(d);
    }
  }

  return { init, add, remove, has, open, count, render, current: () => st.list?.list ?? null, reload: load, listInfo: current };
}
