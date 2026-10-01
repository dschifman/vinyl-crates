// search.js -- the catalog search. It runs in the client's browser, over the
// whole snapshot loaded once from /api/catalog, so typing is instant on a
// phone and works on bad venue Wi-Fi. The node tests import it unchanged.
//
// A query is a set of words that must ALL match somewhere in a song: its
// title, artist, mix names and remixer credits, or the records it is on.
// Each word matches exactly, as a prefix ("sylv" -> Sylvester), or within a
// typo or two ("dona sumer" -> Donna Summer).

// Mirrors client_catalog.norm() in vinyl-command: the catalog's song keys are
// folded this way, so a client's typing must be folded the same way.
const DISAMBIGUATION = /\s\(\d+\)/g;
const FOLD = {
  "ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ß": "ss",
  "đ": "d", "Đ": "d", "ð": "d", "Ð": "d", "ł": "l", "Ł": "l", "þ": "th", "Þ": "th",
};
const FOLD_RE = /[øØæÆœŒßđĐðÐłŁþÞ]/g;

export function norm(s) {
  let out = String(s ?? "").replace(DISAMBIGUATION, "").replace(FOLD_RE, (c) => FOLD[c]);
  out = out.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  out = out.replace(/['’]/g, "");
  return out.replace(/[^a-z0-9]+/g, " ").trim();
}

export function words(s) {
  const n = norm(s);
  return n ? n.split(" ") : [];
}

// Where a word was found, strongest first, and what each is worth.
const TITLE = 0, ARTIST = 1, MIX = 2, RECORD = 3;
const FIELD_WEIGHT = [4, 3, 2, 1];
const EXACT = 3, PREFIX = 2, FUZZY = 1;

// The snapshot's format categories (client_catalog.format_category).
export const FORMATS = ['12"', "LP", '7"', '10"', "other"];
export const FORMAT_LABELS = {
  '12"': "12-inch singles", LP: "Albums", '7"': "7-inch singles", '10"': "10-inch", other: "Other",
};
export const FORMAT_SHORT = {
  '12"': "12-inch", LP: "Album", '7"': "7-inch", '10"': "10-inch", other: "Other",
};
export const FORMAT_BIT = { '12"': 1, LP: 2, '7"': 4, '10"': 8, other: 16 };

export function buildIndex(snapshot) {
  const songs = snapshot.songs || [];
  const releases = snapshot.releases || {};
  const postings = new Map();                 // word -> [songIndex * 4 + field, ...]
  const formatsOf = new Uint8Array(songs.length);
  const decades = new Map();                  // 1970 -> songs from the 70s

  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    const best = new Map();                   // word -> strongest field it appears in
    const add = (text, field, compact) => {
      const ws = words(text);
      for (const w of ws) {
        const f = best.get(w);
        if (f === undefined || field < f) best.set(w, field);
      }
      // "Y.M.C.A." folds to "y m c a" and "AC/DC" to "ac dc": also index the
      // name run together, so "ymca" and "acdc" find them.
      if (compact && ws.length >= 2 && ws.length <= 4) {
        const joined = ws.join("");
        if (joined.length <= 12 && !best.has(joined)) best.set(joined, field);
      }
    };
    add(s.t, TITLE, true);
    add(s.a, ARTIST, true);
    let mask = 0;
    for (const v of s.v || []) {
      const [rid, , mix, , credits] = v;
      if (mix) add(mix, MIX, false);
      for (const c of credits || []) add(c, MIX, false);
      const r = releases[String(rid)];
      if (r) {
        add(r.t, RECORD, false);
        add(r.l, RECORD, false);
        mask |= FORMAT_BIT[r.f] || FORMAT_BIT.other;
      }
    }
    formatsOf[i] = mask;
    for (const [w, field] of best) {
      let list = postings.get(w);
      if (!list) postings.set(w, (list = []));
      list.push(i * 4 + field);
    }
    if (s.y) {
      const d = Math.floor(s.y / 10) * 10;
      decades.set(d, (decades.get(d) || 0) + 1);
    }
  }

  const occasionMoments = {};
  for (const o of snapshot.occasions || []) occasionMoments[o.name] = o.moments || [];

  const vocab = [...postings.keys()].sort();
  const byLength = [];                        // the typo scan only reads words of a near length
  for (const w of vocab) (byLength[w.length] ||= []).push(w);

  return {
    songs,
    releases,
    postings,
    vocab,
    byLength,
    formatsOf,
    decades: [...decades.entries()].sort((a, b) => a[0] - b[0]),
    occasionMoments,
  };
}

// Optimal string alignment distance (a swap of two neighbouring letters counts
// once), giving up as soon as it must exceed `max`.
export function editDistance(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let twoBack = new Array(lb + 1).fill(0);
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, twoBack[j - 2] + 1);
      }
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    const spare = twoBack;
    twoBack = prev;
    prev = cur;
    cur = spare;
  }
  return prev[lb];
}

function lowerBound(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// song index -> best score this one query word earns it
function wordMatches(index, w, isLast) {
  const scores = new Map();
  const take = (word, quality, maxField = RECORD) => {
    for (const p of index.postings.get(word)) {
      if ((p & 3) > maxField) continue;
      const i = p >> 2;
      const s = quality * FIELD_WEIGHT[p & 3];
      const had = scores.get(i);
      if (had === undefined || s > had) scores.set(i, s);
    }
  };
  if (index.postings.has(w)) take(w, EXACT);
  // A prefix needs two letters, except on the word still being typed.
  if (isLast || w.length >= 2) {
    for (let j = lowerBound(index.vocab, w); j < index.vocab.length; j++) {
      const v = index.vocab[j];
      if (!v.startsWith(w)) break;
      if (v !== w) take(v, PREFIX);
    }
  }
  // Typos are forgiven in titles and artists only: one in a word of 4-5
  // letters, two from 6 ("mikael" -> michael, "nagila" -> nageela). Matching
  // labels and record titles loosely would only add noise ("ymca" ~ MCA).
  const max = w.length >= 6 ? 2 : w.length >= 4 ? 1 : 0;
  for (let len = w.length - max; max && len <= w.length + max; len++) {
    for (const v of index.byLength[len] || []) {
      if (v === w || v.startsWith(w)) continue;
      if (editDistance(w, v, max) <= max) take(v, FUZZY, ARTIST);
    }
  }
  return scores;
}

export function makeFilter(index, f = {}) {
  const checks = [];
  const songs = index.songs;
  if (f.moment) {
    checks.push((i) => (songs[i].m || []).includes(f.moment));
  } else if (f.occasion) {
    const wanted = new Set(index.occasionMoments[f.occasion] || []);
    checks.push((i) => (songs[i].m || []).some((m) => wanted.has(m)));
  }
  if (f.buckets && f.buckets.size) {
    checks.push((i) => (songs[i].b || []).some((b) => f.buckets.has(b)));
  }
  if (f.decades && f.decades.size) {
    checks.push((i) => songs[i].y != null && f.decades.has(Math.floor(songs[i].y / 10) * 10));
  }
  if (f.formats && f.formats.size) {
    let mask = 0;
    for (const x of f.formats) mask |= FORMAT_BIT[x] || 0;
    checks.push((i) => (index.formatsOf[i] & mask) !== 0);
  }
  return checks.length ? (i) => checks.every((c) => c(i)) : () => true;
}

// Song indexes, best first. With no words, every song that passes the
// filters, in the snapshot's order (artist, then title).
export function search(index, query, filters = {}) {
  const pass = makeFilter(index, filters);
  const ws = words(query);
  if (!ws.length) {
    const out = [];
    for (let i = 0; i < index.songs.length; i++) if (pass(i)) out.push(i);
    return out;
  }
  const perWord = ws.map((w, k) => wordMatches(index, w, k === ws.length - 1));
  perWord.sort((a, b) => a.size - b.size);
  const hits = [];
  outer: for (const [i, first] of perWord[0]) {
    let total = first;
    for (let k = 1; k < perWord.length; k++) {
      const s = perWord[k].get(i);
      if (s === undefined) continue outer;
      total += s;
    }
    if (pass(i)) hits.push([i, total]);
  }
  const songs = index.songs;
  hits.sort((a, b) => b[1] - a[1] || songs[b[0]].v.length - songs[a[0]].v.length || a[0] - b[0]);
  return hits.map((h) => h[0]);
}
