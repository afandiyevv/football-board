
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 12783;
const CACHE_MS = 5 * 60 * 1000;

function writeJsonFile(file, obj) {
  const s = JSON.stringify(obj).replace(/[\u0080-\uFFFF]/g, function (ch) {
    return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
  fs.writeFileSync(file, s, 'utf8');
}

const FB_KEY = process.env.FB_KEY || '';
const FB_FILE = path.join(process.env.HOME, 'public_html', 'football.json');
const FB_MATCH_FILE = path.join(process.env.HOME, 'public_html', 'match.json');
const FB_LEAGUES = { PL: 'Premier League', PD: 'La Liga', BL1: 'Bundesliga', SA: 'Serie A' };
const fbCache = {};

function fetchFB(pathPart) {
  return new Promise((resolve, reject) => {
    https.get({ host: 'api.football-data.org', path: pathPart,
      headers: { 'X-Auth-Token': FB_KEY } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function slimMatch(m) {
  return {
    id: m.id, utcDate: m.utcDate, matchday: m.matchday, status: m.status,
    home: m.homeTeam ? m.homeTeam.shortName || m.homeTeam.name : '?',
    away: m.awayTeam ? m.awayTeam.shortName || m.awayTeam.name : '?',
    home_id: m.homeTeam ? m.homeTeam.id : null,
    away_id: m.awayTeam ? m.awayTeam.id : null,
    home_crest: m.homeTeam ? m.homeTeam.crest : null,
    away_crest: m.awayTeam ? m.awayTeam.crest : null,
    score: m.score && m.score.fullTime ? m.score.fullTime : null,
  };
}

async function buildFbMatches(league) {
  if (!FB_LEAGUES[league]) return { ok: false, error: 'unknown league' };
  const c = fbCache[league];
  let payload;
  if (c && Date.now() - c.t < CACHE_MS) {
    payload = c.data;
  } else {
    const d0 = new Date(Date.now() - 14 * 24 * 3600 * 1000), d1 = new Date(Date.now() + 10 * 24 * 3600 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const [res, st] = await Promise.all([
      fetchFB('/v4/competitions/' + league + '/matches?dateFrom=' + fmt(d0) + '&dateTo=' + fmt(d1)),
      fetchFB('/v4/competitions/' + league + '/standings').catch(() => null),
    ]);
    if (!res || !res.matches) return { ok: false, error: res && res.message ? res.message : 'no data' };
    const all = res.matches.slice().sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
    const finished = all.filter((m) => m.status === 'FINISHED');
    let lastMd = finished.length ? finished[finished.length - 1].matchday : (all.length ? all[0].matchday : 0);
    let mdMatches = all.filter((m) => m.matchday === lastMd);
    if (mdMatches.length < 3) mdMatches = finished.slice(-10);
    let table = [];
    try {
      const t = (st.standings || []).find((x) => x.type === 'TOTAL') || st.standings[0];
      table = t.table.map((r) => ({
        pos: r.position, team: r.team.shortName || r.team.name,
        p: r.playedGames, gd: r.goalDifference, pts: r.points,
      }));
    } catch (e) {}
    payload = { league: league, league_name: FB_LEAGUES[league],
      matchday: (mdMatches[0] && mdMatches[0].matchday) || lastMd,
      matches: mdMatches.map(slimMatch), table: table };
    fbCache[league] = { t: Date.now(), data: payload };
  }
  const out = Object.assign({ generated_at: new Date().toISOString(), ok: true }, payload);
  writeJsonFile(FB_FILE, out);
  return out;
}

async function teamForm(teamId) {
  const d0 = new Date(Date.now() - 120 * 24 * 3600 * 1000), d1 = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const res = await fetchFB('/v4/teams/' + teamId + '/matches?status=FINISHED&dateFrom=' + fmt(d0) + '&dateTo=' + fmt(d1));
  if (!res || !res.matches) return [];
  const sorted = res.matches.sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate)).slice(0, 5);
  return sorted.map((m) => {
    const isHome = m.homeTeam && m.homeTeam.id === teamId;
    const gf = m.score.fullTime ? (isHome ? m.score.fullTime.home : m.score.fullTime.away) : null;
    const ga = m.score.fullTime ? (isHome ? m.score.fullTime.away : m.score.fullTime.home) : null;
    let r = 'D';
    if (gf != null && ga != null) r = gf > ga ? 'W' : (gf < ga ? 'L' : 'D');
    return { date: m.utcDate, opponent: isHome ? (m.awayTeam.shortName || m.awayTeam.name) : (m.homeTeam.shortName || m.homeTeam.name),
      home: isHome, gf: gf, ga: ga, result: r };
  });
}

async function buildFbMatch(league, idx) {
  let fb;
  try { fb = JSON.parse(fs.readFileSync(FB_FILE, 'utf8')); } catch (e) { return { ok: false, error: 'no matches file' }; }
  const m = fb.matches && fb.matches[idx];
  if (!m) return { ok: false, error: 'no such match' };
  const [hf, af] = await Promise.all([
    m.home_id ? teamForm(m.home_id) : [],
    m.away_id ? teamForm(m.away_id) : [],
  ]);
  const out = { generated_at: new Date().toISOString(), ok: true,
    league_name: fb.league_name, match: m, home_form: hf, away_form: af };
  writeJsonFile(FB_MATCH_FILE, out);
  return out;
}

const FB_TABLE_FILE = path.join(process.env.HOME, 'public_html', 'table.json');
const tableCache = {};

async function buildFbTable(league) {
  if (!FB_LEAGUES[league]) return { ok: false, error: 'unknown league' };
  const c = tableCache[league];
  let table;
  if (c && Date.now() - c.t < CACHE_MS) {
    table = c.data;
  } else {
    const res = await fetchFB('/v4/competitions/' + league + '/standings');
    const tot = res && res.standings ? res.standings.find((s) => s.type === 'TOTAL') : null;
    if (!tot || !tot.table) return { ok: false, error: res && res.message ? res.message : 'no standings' };
    table = tot.table.map((r) => ({
      pos: r.position, team: r.team ? (r.team.shortName || r.team.name) : '?',
      crest: r.team ? r.team.crest : null, played: r.playedGames,
      w: r.won, d: r.draw, l: r.lost, gf: r.goalsFor, ga: r.goalsAgainst,
      gd: r.goalDifference, pts: r.points, form: r.form || null,
    }));
    tableCache[league] = { t: Date.now(), data: table };
  }
  const out = { generated_at: new Date().toISOString(), ok: true,
    league: league, league_name: FB_LEAGUES[league], table: table };
  writeJsonFile(FB_TABLE_FILE, out);
  return out;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (req.url.indexOf('/fb_table') === 0) {
      const u = new URL(req.url, 'http://localhost');
      res.end(JSON.stringify(await buildFbTable((u.searchParams.get('league') || '').trim())));
    } else if (req.url.indexOf('/fb_matches') === 0) {
      const u = new URL(req.url, 'http://localhost');
      res.end(JSON.stringify(await buildFbMatches((u.searchParams.get('league') || '').trim())));
    } else if (req.url.indexOf('/fb_match') === 0) {
      const u = new URL(req.url, 'http://localhost');
      res.end(JSON.stringify(await buildFbMatch((u.searchParams.get('league') || '').trim(),
        parseInt(u.searchParams.get('idx') || '0', 10))));
    } else {
      res.end(JSON.stringify({ ok: true, service: 'football', leagues: Object.keys(FB_LEAGUES) }));
    }
  } catch (e) {
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
});

server.listen(PORT, () => {
  console.log('Football backend running on port ' + PORT);
});
