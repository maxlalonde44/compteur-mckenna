// Robot du Compteur McKenna : va chercher les données de la LNH et met à jour data.json.
// Lancé chaque heure par GitHub Actions. En cas de problème, il s'arrête SANS toucher data.json.
import { readFile, writeFile } from "node:fs/promises";

const PLAYER_ID = 8486067;            // Gavin McKenna
const TEAM = "TOR";
const SEASON = "20262027";
const SEASON_START = "2026-09-29";
const API = "https://api-web.nhle.com/v1";
const DATA_FILE = new URL("./data.json", import.meta.url);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(API + path, { headers: { "User-Agent": "compteur-mckenna/1.0" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      throw new Error("HTTP " + r.status);
    } catch (e) {
      if (i === tries) throw new Error(`Échec ${path} : ${e.message}`);
      await sleep(1500 * i);
    }
  }
}
async function pool(items, n, fn) {
  const out = []; let k = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (k < items.length) { const i = k++; out[i] = await fn(items[i]); await sleep(120); }
  }));
  return out;
}
const isDone = s => s === "FINAL" || s === "OFF";
const skaters = side => [...(side?.forwards || []), ...(side?.defense || [])];
const nm = o => ({ fr: (o && (o.fr || o.default)) || "", en: (o && o.default) || "" });

async function main() {
  const prev = JSON.parse(await readFile(DATA_FILE, "utf8"));
  const data = structuredClone(prev);
  const now = Date.now();

  // 1) Matchs de McKenna + mises en échec par match
  const log = await get(`/player/${PLAYER_ID}/game-log/${SEASON}/2`);
  if (!log || !Array.isArray(log.gameLog)) throw new Error("game-log inattendu");
  const cache = Object.fromEntries((prev.mckenna?.games || []).map(g => [g.id, g]));
  const games = [];
  for (const g of [...log.gameLog].sort((a, b) => a.gameDate.localeCompare(b.gameDate))) {
    // on garde en mémoire les matchs de plus de 2 jours; les plus récents sont revérifiés (corrections de stats)
    const old = now - Date.parse(g.gameDate + "T12:00:00Z") > 2 * 864e5;
    if (cache[g.gameId] && old) { games.push(cache[g.gameId]); continue; }
    const box = await get(`/gamecenter/${g.gameId}/boxscore`);
    const me = [...skaters(box?.playerByGameStats?.awayTeam), ...skaters(box?.playerByGameStats?.homeTeam)]
      .find(p => p.playerId === PLAYER_ID);
    if (!me || typeof me.hits !== "number") throw new Error(`Mises en échec introuvables pour le match ${g.gameId}`);
    games.push({ id: g.gameId, date: g.gameDate, opp: g.opponentAbbrev, home: g.homeRoadFlag === "H", hits: me.hits });
    await sleep(150);
  }
  const hits = games.reduce((a, g) => a + g.hits, 0);
  const firstIdx = games.findIndex(g => g.hits > 0);
  data.mckenna = {
    gp: games.length,
    hits,
    firstHit: firstIdx >= 0 ? { ...games[firstIdx], gameNumber: firstIdx + 1 } : null,
    games
  };
  if (data.mckenna.gp < (prev.mckenna?.gp || 0)) throw new Error("Moins de matchs qu'avant : données suspectes");

  // 2) Top des mises en échec dans un seul match (toute la LNH)
  const done = new Set(prev.leaders?.processed || []);
  let top = done.size ? (prev.leaders?.top || []) : [];
  const todo = [];
  let day = SEASON_START;
  const today = new Date(now).toISOString().slice(0, 10);
  while (day <= today) {
    const wk = await get(`/schedule/${day}`);
    for (const d of wk?.gameWeek || []) for (const g of d.games || [])
      if (g.gameType === 2 && isDone(g.gameState) && !done.has(g.id)) todo.push(g.id);
    const next = new Date(day + "T12:00:00Z"); next.setUTCDate(next.getUTCDate() + 7);
    day = next.toISOString().slice(0, 10);
    await sleep(120);
  }
  const uniq = [...new Set(todo)];
  console.log(`Matchs à analyser pour le top : ${uniq.length}`);
  await pool(uniq, 4, async id => {
    const box = await get(`/gamecenter/${id}/boxscore`);
    if (!box) return;
    const A = box.awayTeam?.abbrev, H = box.homeTeam?.abbrev, date = box.gameDate;
    for (const [side, team, opp, home] of [["awayTeam", A, H, false], ["homeTeam", H, A, true]])
      for (const p of skaters(box.playerByGameStats?.[side]))
        if (typeof p.hits === "number" && p.hits >= 6)
          top.push({ id: p.playerId, name: p.name?.default || "?", team, opp, home, date, hits: p.hits, game: id });
    done.add(id);
  });
  top = top.filter((t, i, a) => a.findIndex(u => u.game === t.game && u.id === t.id) === i)
           .sort((a, b) => b.hits - a.hits || a.date.localeCompare(b.date)).slice(0, 25);
  data.leaders = { top, processed: [...done] };

  // 3) Sondage : bloc des 3 prochains matchs des Leafs
  const sched = await get(`/club-schedule-season/${TEAM}/${SEASON}`);
  if (!sched || !Array.isArray(sched.games)) throw new Error("calendrier inattendu");
  const team = t => ({ abbrev: t.abbrev, place: nm(t.placeName), name: nm(t.commonName) });
  const upcoming = sched.games
    .filter(g => g.gameType === 2 && (g.gameState === "FUT" || g.gameState === "PRE"))
    .sort((a, b) => a.startTimeUTC.localeCompare(b.startTimeUTC))
    .map(g => {
      const home = g.homeTeam.abbrev === TEAM;
      return { choice: "g" + g.id, gameId: g.id, start: g.startTimeUTC, home, opp: team(home ? g.awayTeam : g.homeTeam) };
    });
  const poll = prev.poll;
  const lastStart = poll?.games?.length ? Date.parse(poll.games[poll.games.length - 1].start) : 0;
  const pollOver = !poll || now > lastStart + 4 * 3600e3;
  if (hits > 0) {
    data.poll = { ...poll, resolved: true };          // il a frappé : le sondage est terminé
  } else if (pollOver && upcoming.length) {
    const g3 = upcoming.slice(0, 3);
    data.poll = { id: "p" + g3[0].gameId, games: g3, resolved: false };
    console.log("Nouveau sondage :", data.poll.id);
  }

  data.updated = new Date(now).toISOString();
  const changed = JSON.stringify({ ...data, updated: 0 }) !== JSON.stringify({ ...prev, updated: 0 });
  if (!changed) { console.log("Rien de nouveau."); return; }
  await writeFile(DATA_FILE, JSON.stringify(data, null, 1) + "\n");
  console.log(`OK : ${data.mckenna.gp} matchs, ${data.mckenna.hits} mise(s) en échec, top = ${top[0]?.name} (${top[0]?.hits})`);
}

main().catch(e => { console.error("ERREUR :", e.message); process.exit(1); });
