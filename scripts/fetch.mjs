import { writeFile, mkdir } from "node:fs/promises";

const FD_KEY = process.env.FOOTBALL_DATA_KEY;   // required
const AF_KEY = process.env.API_FOOTBALL_KEY;    // optional, adds cups for Barça/Madrid
const DAYS_AHEAD = 60;

const COMPS = {
  PD: "La Liga", CL: "Champions League", PL: "Premier League",
  BL1: "Bundesliga", SA: "Serie A", FL1: "Ligue 1",
};
const BARCA = { fd: 81, af: 529, names: ["fc barcelona", "barcelona"] };
const MADRID = { fd: 86, af: 541, names: ["real madrid cf", "real madrid"] };

// [team A, team B, snippet] matched on lowercase, accent-free name fragments
const DERBIES = [
  ["real madrid", "atletico", "Madrid derby: city bragging rights on top of the points."],
  ["fc barcelona", "espanyol", "Barcelona derby: the city's two clubs meet."],
  ["sevilla", "betis", "Seville derby: one of Spain's fiercest rivalries."],
  ["athletic", "real sociedad", "Basque derby."],
  ["arsenal", "tottenham", "North London derby."],
  ["liverpool", "everton", "Merseyside derby."],
  ["manchester united", "manchester city", "Manchester derby."],
  ["liverpool", "manchester united", "England's two most decorated clubs meet."],
  ["internazionale", "ac milan", "Derby della Madonnina: Milan's two giants share one stadium."],
  ["juventus", "internazionale", "Derby d'Italia."],
  ["as roma", "lazio", "Derby della Capitale: Rome's rivalry."],
  ["bayern", "dortmund", "Der Klassiker: Germany's headline fixture."],
  ["paris saint-germain", "marseille", "Le Classique: France's biggest rivalry."],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const ord = (n) => n + (["th", "st", "nd", "rd"][(n % 100 >> 3) ^ 1 && n % 10] || "th");
const pretty = (s) => norm(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const day = (d) => d.toISOString().slice(0, 10);

function tag(src, home, away) {
  const is = (club, t) => t.id === club[src] || club.names.includes(norm(t.name));
  const b = is(BARCA, home) || is(BARCA, away);
  const m = is(MADRID, home) || is(MADRID, away);
  return b && m ? "clasico" : b ? "barca" : m ? "madrid" : null;
}

async function fd(path) {
  const res = await fetch("https://api.football-data.org/v4" + path, {
    headers: { "X-Auth-Token": FD_KEY },
  });
  await sleep(6500); // free tier allows 10 requests per minute
  if (!res.ok) throw new Error(`football-data ${path} -> ${res.status}`);
  return res.json();
}

function importance(m, table) {
  if (m.highlight === "clasico") return "El Clásico: the biggest fixture in Spanish football.";
  const h = norm(m.homeFull), a = norm(m.awayFull);
  const derby = DERBIES.find(([x, y]) => (h.includes(x) && a.includes(y)) || (h.includes(y) && a.includes(x)));
  const parts = derby ? [derby[2]] : [];

  const knockout = m.code === "CL" && m.stage && !["LEAGUE_STAGE", "GROUP_STAGE"].includes(m.stage);
  if (knockout) parts.push(`Champions League ${pretty(m.stage)}: knockout football.`);

  const H = table?.get(m.homeId), A = table?.get(m.awayId);
  if (!knockout && H && A && Math.min(H.played, A.played) >= 3) {
    const [hi, lo] = H.position < A.position ? [H, A] : [A, H];
    const gap = Math.abs(H.points - A.points);
    const pts = `${gap} point${gap === 1 ? "" : "s"}`;
    const n = table.size;
    if (m.code === "CL") {
      parts.push(`${ord(H.position)} vs ${ord(A.position)} in the league phase. Top 8 go straight to the last 16, 9th to 24th face a play-off.`);
    } else if (lo.position <= 2) {
      parts.push(`1st vs 2nd: a direct title showdown with ${pts} between them.`);
    } else if (lo.position <= 4) {
      parts.push(`Top-four clash: ${ord(H.position)} vs ${ord(A.position)}, ${pts} apart.`);
    } else if (hi.position >= n - 4) {
      parts.push(`Relegation fight: ${ord(H.position)} vs ${ord(A.position)}, ${pts} apart.`);
    } else if (hi.position === 1) {
      parts.push(`${hi.name} are top of the table and face the ${ord(lo.position)}-placed side.`);
    } else {
      parts.push(`${ord(H.position)} (${H.points} pts) vs ${ord(A.position)} (${A.points} pts).`);
    }
  }
  if (!parts.length) parts.push(m.stageLabel || m.competition);
  return parts.join(" ");
}

async function leagueMatches(from, to) {
  const out = [];
  for (const [code, name] of Object.entries(COMPS)) {
    const { matches } = await fd(`/competitions/${code}/matches`);

    const table = new Map();
    try {
      const s = await fd(`/competitions/${code}/standings`);
      const total = s.standings.find((x) => x.type === "TOTAL") ?? s.standings[0];
      for (const r of total.table)
        table.set(r.team.id, { position: r.position, points: r.points, played: r.playedGames, name: r.team.shortName ?? r.team.name });
    } catch (e) { console.warn(e.message); }

    const venues = new Map();
    try {
      const t = await fd(`/competitions/${code}/teams`);
      for (const team of t.teams) venues.set(team.id, team.venue);
    } catch (e) { console.warn(e.message); }

    for (const x of matches) {
      const d = x.utcDate.slice(0, 10);
      if (d < from || d > to || !x.homeTeam?.id || !x.awayTeam?.id) continue;
      const m = {
        id: `fd-${x.id}`,
        utcDate: x.utcDate,
        code,
        competition: name,
        stage: x.stage,
        stageLabel: x.stage === "REGULAR_SEASON" ? `Matchday ${x.matchday}` : pretty(x.stage),
        home: x.homeTeam.shortName ?? x.homeTeam.name,
        away: x.awayTeam.shortName ?? x.awayTeam.name,
        homeFull: x.homeTeam.name, awayFull: x.awayTeam.name,
        homeId: x.homeTeam.id, awayId: x.awayTeam.id,
        venue: x.venue ?? venues.get(x.homeTeam.id) ?? null,
        status: x.status,
        score: x.status === "FINISHED" ? `${x.score.fullTime.home}-${x.score.fullTime.away}` : null,
        highlight: tag("fd", x.homeTeam, x.awayTeam),
      };
      m.importance = importance(m, table);
      out.push(m);
    }
    console.log(`${name}: ${matches.length} season matches loaded`);
  }
  return out;
}

async function cupMatches(from, to) {
  if (!AF_KEY) return [];
  const now = new Date();
  const season = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const out = new Map();
  for (const team of [BARCA.af, MADRID.af]) {
    try {
      const url = `https://v3.football.api-sports.io/fixtures?team=${team}&season=${season}&from=${from}&to=${to}`;
      const data = await (await fetch(url, { headers: { "x-apisports-key": AF_KEY } })).json();
      if (data.errors && Object.keys(data.errors).length) {
        console.warn("API-Football:", JSON.stringify(data.errors));
        continue;
      }
      for (const f of data.response ?? []) {
        if ([140, 2].includes(f.league.id)) continue; // La Liga and CL already covered
        const friendly = /friendl/i.test(f.league.name);
        const m = {
          id: `af-${f.fixture.id}`,
          utcDate: new Date(f.fixture.date).toISOString(),
          code: "CUP",
          competition: f.league.name,
          stageLabel: f.league.round,
          home: f.teams.home.name, away: f.teams.away.name,
          venue: f.fixture.venue?.name ?? null,
          status: f.fixture.status.short === "FT" ? "FINISHED" : "SCHEDULED",
          score: f.fixture.status.short === "FT" ? `${f.goals.home}-${f.goals.away}` : null,
          highlight: tag("af", f.teams.home, f.teams.away),
        };
        m.importance = m.highlight === "clasico"
          ? `El Clásico in the ${f.league.name}.`
          : friendly ? "Friendly." : `${f.league.round}. Cup football, so a slip here can end the run.`;
        out.set(m.id, m);
      }
    } catch (e) { console.warn("API-Football failed:", e.message); }
  }
  return [...out.values()];
}

if (!FD_KEY) throw new Error("FOOTBALL_DATA_KEY is not set");
const from = day(new Date(Date.now() - 864e5));
const to = day(new Date(Date.now() + DAYS_AHEAD * 864e5));

const all = [...(await leagueMatches(from, to)), ...(await cupMatches(from, to))]
  .map(({ homeFull, awayFull, homeId, awayId, stage, ...m }) => m)
  .sort((a, b) => a.utcDate.localeCompare(b.utcDate));

await mkdir("data", { recursive: true });
await writeFile("data/matches.json", JSON.stringify({ updated: new Date().toISOString(), matches: all }, null, 1));
console.log(`Wrote ${all.length} matches (${from} to ${to})`);
