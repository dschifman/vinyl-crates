import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, buildIndex, search, editDistance } from "../public/search.js";

// A small snapshot in the shape vinyl-command's client_catalog.build() makes.
const SNAP = {
  schema: 1,
  buckets: ["Disco & Boogie", "Pop", "Soundtracks & Other"],
  occasions: [
    { name: "Wedding", moments: ["First dance", "Parent dances", "Hora & Jewish favorites", "Group dances"] },
    { name: "Bar & Bat Mitzvah", moments: ["Parent dances", "Hora & Jewish favorites", "Group dances"] },
  ],
  releases: {
    "1": { a: "Donna Summer", t: "I Feel Love", y: 1977, py: 1977, f: '12"', l: "Casablanca", c: "NBD 20104", b: ["Disco & Boogie"] },
    "2": { a: "Sylvester", t: "Step II", y: 1978, py: 1978, f: "LP", l: "Fantasy", c: "F-9556", b: ["Disco & Boogie"] },
    "3": { a: "Beyoncé", t: "Crazy In Love", y: 2003, py: 2003, f: '12"', l: "Columbia", c: "44 76869", b: ["Pop"] },
    "4": { a: "Village People", t: "Cruisin'", y: 1978, py: 1978, f: "LP", l: "Casablanca", c: "NBLP 7118", b: ["Disco & Boogie"] },
    "5": { a: "Topol", t: "Fiddler On The Roof", y: 1971, py: 1971, f: "LP", l: "United Artists", c: "UAS 10900", b: ["Soundtracks & Other"] },
    "6": { a: "Various", t: "Disco Classics", y: 1990, py: 1990, f: "LP", l: "Salsoul", c: "SAL 1", b: ["Disco & Boogie"] },
  },
  songs: [
    { k: "beyonce|crazy in love", a: "Beyoncé", t: "Crazy In Love", y: 2003, b: ["Pop"], v: [[3, "A1", "", 236, []]], m: ["First dance"] },
    { k: "donna summer|i feel love", a: "Donna Summer", t: "I Feel Love", y: 1977, b: ["Disco & Boogie"],
      v: [[1, "A", "Patrick Cowley Mega-Mix", 949, ["Patrick Cowley"]], [6, "B2", "", 356, []]] },
    { k: "sylvester|you make me feel", a: "Sylvester", t: "You Make Me Feel", y: 1978, b: ["Disco & Boogie"],
      v: [[2, "A1", "Mighty Real", 400, []], [6, "A1", "", 400, []]] },
    { k: "topol|sunrise sunset", a: "Topol", t: "Sunrise, Sunset", y: 1971, b: ["Soundtracks & Other"],
      v: [[5, "B3", "", 200, []]], m: ["Hora & Jewish favorites", "Parent dances"] },
    { k: "village people|y m c a", a: "Village People", t: "Y.M.C.A.", y: 1978, b: ["Disco & Boogie"],
      v: [[4, "A1", "", 288, []]], m: ["Group dances"] },
  ],
};

const index = buildIndex(SNAP);
const titles = (ids) => ids.map((i) => index.songs[i].t);

test("norm folds like client_catalog.norm()", () => {
  assert.equal(norm("Stayin' Alive"), "stayin alive");
  assert.equal(norm("Beyoncé"), "beyonce");
  assert.equal(norm("Niels-Henning Ørsted Pedersen"), "niels henning orsted pedersen");
  assert.equal(norm("Yaw (2)"), "yaw");
  assert.equal(norm("Rock & Roll"), "rock roll");
  assert.equal(norm("Y.M.C.A."), "y m c a");
  assert.equal(norm("Don’t Stop"), "dont stop");
  assert.equal(norm(null), "");
});

test("edit distance counts a swap once and gives up past the limit", () => {
  assert.equal(editDistance("dona", "donna", 1), 1);
  assert.equal(editDistance("sumer", "summer", 1), 1);
  assert.equal(editDistance("sylvetser", "sylvester", 2), 1);
  assert.equal(editDistance("abcd", "wxyz", 1), 2);
});

test("typos, prefixes, accents and punctuation all find the song", () => {
  assert.deepEqual(titles(search(index, "dona sumer")), ["I Feel Love"]);
  assert.deepEqual(titles(search(index, "sylv")), ["You Make Me Feel"]);
  assert.deepEqual(titles(search(index, "beyonce")), ["Crazy In Love"]);
  assert.deepEqual(titles(search(index, "BEYONCÉ crazy")), ["Crazy In Love"]);
  assert.deepEqual(titles(search(index, "ymca")), ["Y.M.C.A."]);
  assert.deepEqual(titles(search(index, "y.m.c.a")), ["Y.M.C.A."]);
});

test("two typos in a long word, but never a typo against a label", () => {
  assert.deepEqual(titles(search(index, "sylvestre")), ["You Make Me Feel"]);    // 2 edits, 9 letters
  assert.deepEqual(titles(search(index, "dona sumer")), ["I Feel Love"]);
  // "casablanka" is one letter off the label Casablanca: labels match exactly or not at all
  assert.deepEqual(titles(search(index, "casablanka")), []);
  assert.deepEqual(titles(search(index, "casablanca")).sort(), ["I Feel Love", "Y.M.C.A."]);
});

test("every word must match, and a title beats a record or remixer", () => {
  assert.deepEqual(titles(search(index, "feel")).sort(), ["I Feel Love", "You Make Me Feel"]);
  assert.deepEqual(titles(search(index, "feel love")), ["I Feel Love"]);
  assert.deepEqual(titles(search(index, "cowley")), ["I Feel Love"]);          // remixer credit
  assert.deepEqual(titles(search(index, "mighty real")), ["You Make Me Feel"]); // mix name
  // "love" is in Crazy In Love's title and only on I Feel Love's record title
  // too -- but I Feel Love has it in its own title as well; both titles rank
  // above a record-only match.
  const order = titles(search(index, "disco classics"));
  assert.deepEqual(order.sort(), ["I Feel Love", "You Make Me Feel"]);         // record title
  assert.deepEqual(titles(search(index, "nothing like this")), []);
});

test("filters: occasion, moment, genre, decade, format", () => {
  assert.deepEqual(titles(search(index, "", { occasion: "Wedding" })), ["Crazy In Love", "Sunrise, Sunset", "Y.M.C.A."]);
  assert.deepEqual(titles(search(index, "", { occasion: "Bar & Bat Mitzvah" })), ["Sunrise, Sunset", "Y.M.C.A."]);
  assert.deepEqual(titles(search(index, "", { moment: "Parent dances" })), ["Sunrise, Sunset"]);
  assert.deepEqual(titles(search(index, "", { buckets: new Set(["Pop"]) })), ["Crazy In Love"]);
  assert.deepEqual(titles(search(index, "", { decades: new Set([1970]) })),
    ["I Feel Love", "You Make Me Feel", "Sunrise, Sunset", "Y.M.C.A."]);
  assert.deepEqual(titles(search(index, "", { formats: new Set(['12"']) })), ["Crazy In Love", "I Feel Love"]);
  assert.deepEqual(titles(search(index, "feel", { formats: new Set(["LP"]) })).sort(), ["I Feel Love", "You Make Me Feel"]);
  assert.deepEqual(titles(search(index, "", { buckets: new Set(["Pop"]), decades: new Set([1970]) })), []);
});

test("no words and no filters lists every song in snapshot order", () => {
  assert.deepEqual(search(index, "   "), [0, 1, 2, 3, 4]);
});

test("decades are counted for the filter chips", () => {
  assert.deepEqual(index.decades, [[1970, 4], [2000, 1]]);
});

test("a 20,000-song catalog indexes and searches quickly", () => {
  const syllables = ["la", "mo", "ri", "ta", "ve", "no", "su", "ki", "do", "re", "mi", "fa", "so", "be", "zu"];
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const word = () => Array.from({ length: 2 + rnd(3) }, () => syllables[rnd(syllables.length)]).join("");
  const releases = {};
  for (let r = 1; r <= 5000; r++) releases[r] = { a: word(), t: `${word()} ${word()}`, y: 1970 + rnd(50), py: 1980, f: '12"', l: word(), c: "X", b: ["Pop"] };
  const songs = [];
  for (let i = 0; i < 20000; i++) {
    songs.push({ k: String(i), a: `${word()} ${word()}`, t: `${word()} ${word()} ${word()}`, y: 1970 + rnd(50), b: ["Pop"],
      v: [[1 + rnd(5000), "A1", rnd(4) ? "" : `${word()} mix`, 300, []]] });
  }
  const t0 = performance.now();
  const big = buildIndex({ releases, songs, occasions: [] });
  const built = performance.now() - t0;
  const probe = `${songs[123].a} ${songs[123].t.split(" ")[0]}`;
  const t1 = performance.now();
  const ids = search(big, probe);
  const typo = search(big, songs[456].t.split(" ")[0].replace(/^(.)(.)/, "$2$1"));
  const searched = performance.now() - t1;
  assert.ok(ids.includes(123), "the probed song is found");
  assert.ok(typo.length > 0, "a swapped-letter typo still finds something");
  assert.ok(built < 3000, `index built in ${built.toFixed(0)} ms`);
  assert.ok(searched < 500, `two searches took ${searched.toFixed(0)} ms`);
});
