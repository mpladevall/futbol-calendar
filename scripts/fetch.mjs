import { writeFile, mkdir } from "node:fs/promises";

const FD_KEY = process.env.FOOTBALL_DATA_KEY; // required
const DAYS_BACK = 30;
const DAYS_AHEAD = 60;

// football-data.org (free tier)
const COMPS = {
  PD: "La Liga", CL: "Champions League", PL: "Premier League",
  BL1: "Bundesliga", SA: "Serie A", FL1: "Ligue 1",
};
// ESPN public scoreboard (unofficial, no key)
const ESPN_COMPS = {
  "uefa.europa": ["EL", "Europa League"],
  "esp.copa_del_rey": ["CDR", "Copa del Rey"],
  "esp.super_cup": ["SUP", "Supercopa de España"],
  "uefa.nations": ["NL", "Nations League"],
};
const BARCA = { fd: 81, espn: 83, names: ["fc barcelona", "barcelona"] };
const MADRID = { fd: 86, espn: 86, names: ["real madrid cf", "real madrid"] };

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

const FD_STATUS = {
  FINISHED: "FINISHED", AWARDED: "FINISHED", IN_PLAY: "LIVE", PAUSED: "LIVE",
  POSTPONED: "POSTPONED", SUSPENDED: "POSTPONED", CANCELLED: "CANCELLED",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const ord = (n) => n + (["th", "st", "nd", "rd"][(n % 100 >> 3) ^ 1 && n % 10] || "th");
const pretty = (s) => norm(s).replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const day = (d) => d.toISOString().slice(0, 10);

function tag(src, home, away) {
  const is = (club, t) => String(t?.id) === String(club[src]) || club.names.includes(norm(t?.name));
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

// Score and winner. For shoot-outs, fullTime includes the penalties, so use regular + extra time.
function fdResult(score, status) {
  if (status !== "FINISHED" && status !== "LIVE") return {};
  const { regularTime: r, extraTime: e, fullTime: f, penalties: p, duration } = score ?? {};
  const homeGoals = r?.home != null ? r.home + (e?.home ?? 0) : f?.home;
  const awayGoals = r?.away != null ? r.away + (e?.away ?? 0) : f?.away;
  if (homeGoals == null || awayGoals == null) return {};
  if (status === "LIVE") return { homeGoals, awayGoals };
  const winner = { HOME_TEAM: "home", AWAY_TEAM: "away", DRAW: "draw" }[score.winner]
    ?? (homeGoals > awayGoals ? "home" : awayGoals > homeGoals ? "away" : "draw");
  const note = duration === "PENALTY_SHOOTOUT"
    ? `on penalties${p?.home != null ? ` (${p.home}-${p.away})` : ""}`
    : duration === "EXTRA_TIME" ? "after extra time" : null;
  return { homeGoals, awayGoals, winner, note };
}

function importance(m, table) {
  if (m.highlight === "clasico") return "El Clásico: the biggest fixture in Spanish football.";
  const h = norm(m.homeFull), a = norm(m.awayFull);
  const derby = DERBIES.find(([x, y]) => (h.includes(x) && a.includes(y)) || (h.includes(y) && a.includes(x)));
  const parts = derby ? [derby[2]] : [];

  const knockout = m.code === "CL" && m.stage && !["LEAGUE_STAGE", "GROUP_STAGE"].includes(m.stage);
  if (knockout) parts.push(`Champions League ${pretty(m.stage)}: knockout football.`);

  if (m.code === "EL" && m.stageLabel) {
    parts.push(/league/i.test(m.stageLabel)
      ? "Europa League league phase. Top 8 go straight to the last 16, 9th to 24th face a play-off."
      : `Europa League ${m.stageLabel}: knockout football.`);
  }
  if (m.code === "CDR") parts.push("Copa del Rey: knockout football.");

  // The table reflects today, so only use it for matches that have not been played yet.
  const H = table?.get(m.homeId), A = table?.get(m.awayId);
  if (m.status !== "FINISHED" && !knockout && H && A && Math.min(H.played, A.played) >= 3) {
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

const standings = {};

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
      standings[code] = {
        name,
        rows: total.table.map((r) => ({
          pos: r.position, team: r.team.shortName ?? r.team.name,
          played: r.playedGames, won: r.won, draw: r.draw, lost: r.lost,
          gf: r.goalsFor, ga: r.goalsAgainst, gd: r.goalDifference, pts: r.points,
          highlight: tag("fd", r.team, null),
        })),
      };
    } catch (e) { console.warn(e.message); }

    const venues = new Map();
    try {
      const t = await fd(`/competitions/${code}/teams`);
      for (const team of t.teams) venues.set(team.id, team.venue);
    } catch (e) { console.warn(e.message); }

    for (const x of matches) {
      const d = x.utcDate.slice(0, 10);
      if (d < from || d > to || !x.homeTeam?.id || !x.awayTeam?.id) continue;
      const status = FD_STATUS[x.status] ?? "SCHEDULED";
      const m = {
        id: `fd-${x.id}`,
        utcDate: x.utcDate,
        code,
        competition: name,
        stage: x.stage,
        stageLabel: x.stage === "REGULAR_SEASON" ? `Matchday ${x.matchday}` : pretty(x.stage),
        home: x.homeTeam.shortName ?? x.homeTeam.name,
        away: x.awayTeam.shortName ?? x.awayTeam.name,
        homeCode: x.homeTeam.tla ?? null, awayCode: x.awayTeam.tla ?? null,
        homeFull: x.homeTeam.name, awayFull: x.awayTeam.name,
        homeId: x.homeTeam.id, awayId: x.awayTeam.id,
        venue: x.venue ?? venues.get(x.homeTeam.id) ?? null,
        status,
        ...fdResult(x.score, status),
        highlight: tag("fd", x.homeTeam, x.awayTeam),
      };
      m.importance = importance(m, table);
      out.push(m);
    }
    console.log(`${name}: ${matches.length} season matches loaded`);
  }
  return out;
}

async function espnMatches(from, to) {
  const out = [];
  const range = `${from.replaceAll("-", "")}-${to.replaceAll("-", "")}`;
  for (const [slug, [code, name]] of Object.entries(ESPN_COMPS)) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${range}&limit=500`);
      if (!res.ok) throw new Error(`${res.status}`);
      const { events = [] } = await res.json();
      let count = 0;
      for (const e of events) {
        const c = e.competitions?.[0];
        const H = c?.competitors?.find((t) => t.homeAway === "home");
        const A = c?.competitors?.find((t) => t.homeAway === "away");
        if (!H?.team || !A?.team || !e.date) continue;

        const st = c.status?.type ?? e.status?.type ?? {};
        const stName = st.name ?? "";
        const status = /POSTPONED/.test(stName) ? "POSTPONED"
          : /CANCEL|ABANDON/.test(stName) ? "CANCELLED"
          : st.state === "post" ? "FINISHED"
          : st.state === "in" ? "LIVE" : "SCHEDULED";

        const result = {};
        const hg = Number(H.score), ag = Number(A.score);
        if ((status === "FINISHED" || status === "LIVE") && H.score != null && A.score != null && !Number.isNaN(hg + ag)) {
          result.homeGoals = hg;
          result.awayGoals = ag;
          if (status === "FINISHED") {
            result.winner = H.winner ? "home" : A.winner ? "away" : hg > ag ? "home" : ag > hg ? "away" : "draw";
            result.note = /PEN/.test(stName)
              ? `on penalties${H.shootoutScore != null ? ` (${H.shootoutScore}-${A.shootoutScore})` : ""}`
              : /AET/.test(stName) ? "after extra time" : null;
          }
        }

        const m = {
          id: `espn-${e.id}`,
          utcDate: new Date(e.date).toISOString(),
          code,
          competition: name,
          stageLabel: e.season?.slug ? pretty(e.season.slug) : null,
          home: H.team.shortDisplayName ?? H.team.displayName,
          away: A.team.shortDisplayName ?? A.team.displayName,
          homeCode: H.team.abbreviation ?? null, awayCode: A.team.abbreviation ?? null,
          homeFull: H.team.displayName, awayFull: A.team.displayName,
          venue: c.venue?.fullName ?? null,
          status,
          ...result,
          highlight: tag("espn", { id: H.team.id, name: H.team.displayName }, { id: A.team.id, name: A.team.displayName }),
        };
        m.importance = importance(m);
        out.push(m);
        count++;
      }
      console.log(`${name}: ${count} matches loaded (ESPN)`);
    } catch (e) { console.warn(`ESPN ${slug} failed: ${e.message}`); }
  }
  return out;
}

if (!FD_KEY) throw new Error("FOOTBALL_DATA_KEY is not set");
const from = day(new Date(Date.now() - DAYS_BACK * 864e5));
const to = day(new Date(Date.now() + DAYS_AHEAD * 864e5));

const all = [...(await leagueMatches(from, to)), ...(await espnMatches(from, to))]
  .map(({ homeFull, awayFull, homeId, awayId, stage, ...m }) => m)
  .sort((a, b) => a.utcDate.localeCompare(b.utcDate));

await mkdir("data", { recursive: true });
await writeFile("data/matches.json", JSON.stringify(
  { updated: new Date().toISOString(), standings, matches: all }, null, 1));
console.log(`Wrote ${all.length} matches (${from} to ${to})`);
