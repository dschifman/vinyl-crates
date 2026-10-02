// merge.ts -- how several people's lists for one gig become the DJ's list
// (meta-repo docs/dj-client-catalog.md section 5.3). Pure: no storage, no I/O.
//
//   score = role weight x (tier points + rank bonus), summed over members
//
//   tier points   Must 3 · Would love 1
//   rank bonus    (n - rank + 1) / n within that member's tier
//   role weight   host 1.0 · planner 0.75 · guest 0.25
//   veto          a host's "Please don't" removes the song; a planner's flags it
//
// Sorted by score, ties to the earliest request. The formula is written down so
// a client who asks "why is my song 12th?" gets a real answer.

export type Tier = "must" | "want" | "dnp" | "wish";
export type Role = "host" | "planner" | "guest";

export const TIER_POINTS: Record<"must" | "want", number> = { must: 3, want: 1 };
export const ROLE_WEIGHT: Record<Role, number> = { host: 1, planner: 0.75, guest: 0.25 };

export interface MergeMember {
  email: string;
  name: string | null;
  role: Role;
}

export interface MergeRequest {
  id: string;
  email: string;
  song_key: string | null;
  version_key: string | null;
  artist: string;
  title: string;
  mix: string | null;
  tier: Tier;
  rank: number;
  moment: string | null;
  note: string | null;
  created_at: string;
}

export interface MergeEntry {
  email: string;
  name: string | null;
  role: Role;
  tier: Tier;
  rank: number;        // 1-based position within that member's tier
  of: number;          // how many songs that member has in the tier
  points: number;      // this member's contribution to the score
  moment: string | null;
  note: string | null;
  version_key: string | null;
  mix: string | null;
}

export interface MergedSong {
  song_key: string;
  artist: string;
  title: string;
  score: number;
  flagged: boolean;    // a planner said "Please don't"
  first_at: string;    // earliest request, the tie-break
  entries: MergeEntry[];
}

export interface Merged {
  songs: MergedSong[];       // the list to play from, best first
  vetoed: MergedSong[];      // requested, but a host said "Please don't"
  dnp: MergedSong[];         // every "Please don't play", with who said it
  wishes: { artist: string; title: string; entries: MergeEntry[] }[];
}

function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function mergeGig(members: MergeMember[], requests: MergeRequest[]): Merged {
  const who = new Map(members.map((m) => [m.email, m]));
  const byList = new Map<string, MergeRequest[]>();       // "email\u0000tier" -> that list, in order
  for (const r of requests) {
    if (!who.has(r.email)) continue;                      // only current members count
    const k = `${r.email}\u0000${r.tier}`;
    if (!byList.has(k)) byList.set(k, []);
    byList.get(k)!.push(r);
  }

  const songs = new Map<string, MergedSong>();
  const dnp = new Map<string, MergedSong>();
  const vetoes = new Set<string>();
  const flags = new Set<string>();
  const wishes = new Map<string, { artist: string; title: string; entries: MergeEntry[] }>();

  const song = (into: Map<string, MergedSong>, r: MergeRequest): MergedSong => {
    let s = into.get(r.song_key!);
    if (!s) {
      s = { song_key: r.song_key!, artist: r.artist, title: r.title, score: 0, flagged: false, first_at: r.created_at, entries: [] };
      into.set(r.song_key!, s);
    }
    if (r.created_at < s.first_at) s.first_at = r.created_at;
    return s;
  };

  for (const list of byList.values()) {
    list.sort((a, b) => a.rank - b.rank || a.created_at.localeCompare(b.created_at));
    const n = list.length;
    list.forEach((r, i) => {
      const m = who.get(r.email)!;
      const rank = i + 1;
      const entry: MergeEntry = {
        email: r.email, name: m.name, role: m.role, tier: r.tier, rank, of: n, points: 0,
        moment: r.moment, note: r.note, version_key: r.version_key, mix: r.mix,
      };
      if (r.tier === "wish" || !r.song_key) {
        const key = `${fold(r.artist)}|${fold(r.title)}`;
        if (!wishes.has(key)) wishes.set(key, { artist: r.artist, title: r.title, entries: [] });
        wishes.get(key)!.entries.push(entry);
        return;
      }
      if (r.tier === "dnp") {
        song(dnp, r).entries.push(entry);
        if (m.role === "host") vetoes.add(r.song_key);
        else if (m.role === "planner") flags.add(r.song_key);
        return;
      }
      entry.points = ROLE_WEIGHT[m.role] * (TIER_POINTS[r.tier] + (n - rank + 1) / n);
      const s = song(songs, r);
      s.score += entry.points;
      s.entries.push(entry);
    });
  }

  const order = (a: MergedSong, b: MergedSong) =>
    b.score - a.score || a.first_at.localeCompare(b.first_at) || a.title.localeCompare(b.title);
  const kept: MergedSong[] = [];
  const vetoed: MergedSong[] = [];
  for (const s of songs.values()) {
    s.flagged = flags.has(s.song_key);
    (vetoes.has(s.song_key) ? vetoed : kept).push(s);
  }
  kept.sort(order);
  vetoed.sort(order);
  const byName = (a: { artist: string; title: string }, b: { artist: string; title: string }) =>
    a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
  return {
    songs: kept,
    vetoed,
    dnp: [...dnp.values()].sort(byName),
    wishes: [...wishes.values()].sort(byName),
  };
}
