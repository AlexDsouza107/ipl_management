// =====================================================================
//  IPL Management System - backend
//  Express + node-postgres. NO ORM: every query below is plain SQL.
//  Every API response also returns the SQL it ran ("queries"), which
//  the UI shows in its "Show SQL" panel.
// =====================================================================
require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool, types } = require('pg');

// return numbers as numbers and DATEs as plain 'YYYY-MM-DD' strings
types.setTypeParser(20, v => parseInt(v, 10));      // bigint (COUNT)
types.setTypeParser(1700, v => parseFloat(v));      // numeric
types.setTypeParser(1082, v => v);                  // date

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ipl_management',
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const CR = 10000000;                                  // 1 crore

// ---------------------------------------------------------------------
// route(): wraps a handler, gives it a query logger and a transaction
// helper, and returns { data, queries } or { error, queries }.
// ---------------------------------------------------------------------
function route(handler) {
  return async (req, res) => {
    const log = [];
    const ctx = {
      log,
      q: async (text, params = []) => {
        log.push({ text: text.trim(), params });
        return (await pool.query(text, params)).rows;
      },
      tx: async fn => {
        const c = await pool.connect();
        const t = {
          q: async (text, params = []) => {
            log.push({ text: text.trim(), params });
            return (await c.query(text, params)).rows;
          },
        };
        try {
          log.push({ text: 'BEGIN' });
          await c.query('BEGIN');
          const out = await fn(t);
          await c.query('COMMIT');
          log.push({ text: 'COMMIT' });
          return out;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          log.push({ text: 'ROLLBACK' });
          throw e;
        } finally {
          c.release();
        }
      },
    };
    try {
      res.json({ data: await handler(req, ctx), queries: log });
    } catch (e) {
      const status = e.status || (e.code && /^[0-9A-Z]{5}$/.test(e.code) ? 400 : 500);
      const msg = e.code === '23503' && req.method === 'DELETE'
        ? `Cannot delete: other records still depend on this row. ${e.detail || ''}`.trim() : e.message;
      res.status(status).json({ error: msg, code: e.code, constraint: e.constraint, queries: log });
    }
  };
}

async function seasonOf(req, ctx) {
  const n = Number(req.query.season);
  if (n) return n;
  const r = await ctx.q('SELECT season_id FROM season ORDER BY season_year DESC LIMIT 1');
  return r[0] ? r[0].season_id : null;
}

// ---------------------------------------------------------------------
// LOOKUPS (dropdowns)
// ---------------------------------------------------------------------
app.get('/api/lookups', route(async (req, ctx) => ({
  seasons:  await ctx.q('SELECT season_id, season_year FROM season ORDER BY season_year DESC'),
  teams:    await ctx.q('SELECT team_id, team_name FROM team ORDER BY team_name'),
  stadiums: await ctx.q('SELECT stadium_id, stadium_name FROM stadium ORDER BY stadium_name'),
  umpires:  await ctx.q('SELECT umpire_id, umpire_name FROM umpire ORDER BY umpire_name'),
})));

// ---------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------
app.get('/api/dashboard', route(async (req, ctx) => {
  const sid = await seasonOf(req, ctx);
  const [kpi] = await ctx.q(
    `SELECT (SELECT COUNT(*) FROM team_season WHERE season_id = $1)                          AS teams,
            (SELECT COUNT(*) FROM player_team WHERE season_id = $1)                          AS players,
            (SELECT COUNT(*) FROM matches WHERE season_id = $1 AND status <> 'Scheduled')    AS played,
            (SELECT COUNT(*) FROM matches WHERE season_id = $1 AND status = 'Scheduled')     AS remaining,
            (SELECT COALESCE(SUM(contract_value), 0) FROM season_sponsor WHERE season_id = $1) AS sponsorship`, [sid]);
  const points = await ctx.q(
    `SELECT position, team_name, played, won, lost, no_result, points
       FROM v_points_table
      WHERE season_year = (SELECT season_year FROM season WHERE season_id = $1)
      ORDER BY position, team_name`, [sid]);
  const runs = await ctx.q(
    `SELECT p.player_name, SUM(mp.runs) AS runs
       FROM match_performance mp
       JOIN matches m ON m.match_id = mp.match_id
       JOIN player  p ON p.player_id = mp.player_id
      WHERE m.season_id = $1
      GROUP BY p.player_id, p.player_name
      ORDER BY runs DESC
      LIMIT 5`, [sid]);
  const wickets = await ctx.q(
    `SELECT p.player_name, SUM(mp.wickets) AS wickets
       FROM match_performance mp
       JOIN matches m ON m.match_id = mp.match_id
       JOIN player  p ON p.player_id = mp.player_id
      WHERE m.season_id = $1
      GROUP BY p.player_id, p.player_name
      HAVING SUM(mp.wickets) > 0
      ORDER BY wickets DESC
      LIMIT 5`, [sid]);
  return { kpi, points, runs, wickets };
}));

// ---------------------------------------------------------------------
// SEASONS
// ---------------------------------------------------------------------
app.get('/api/seasons', route(async (req, ctx) => ctx.q(
  `SELECT s.season_id, s.season_year, s.start_date, s.end_date,
          (SELECT COUNT(*) FROM team_season ts WHERE ts.season_id = s.season_id) AS teams,
          (SELECT COUNT(*) FROM matches m WHERE m.season_id = s.season_id)       AS total_matches,
          (SELECT sp.company_name
             FROM season_sponsor ss JOIN sponsor sp ON sp.sponsor_id = ss.sponsor_id
            WHERE ss.season_id = s.season_id AND ss.sponsorship_type = 'Title')  AS title_sponsor
     FROM season s
    ORDER BY s.season_year DESC`)));

app.get('/api/seasons/:id', route(async (req, ctx) => {
  const id = Number(req.params.id);
  return {
    teams: await ctx.q(
      `SELECT team_name, purse_total, purse_spent, purse_remaining, squad_size
         FROM v_team_purse WHERE season_id = $1 ORDER BY team_name`, [id]),
    matches: await ctx.q(
      `SELECT m.match_id, m.match_date, m.match_type, t1.team_name AS team1, t2.team_name AS team2,
              m.status, w.team_name AS winner
         FROM matches m
         JOIN team t1 ON t1.team_id = m.team1_id
         JOIN team t2 ON t2.team_id = m.team2_id
         LEFT JOIN team w ON w.team_id = m.winner_id
        WHERE m.season_id = $1 ORDER BY m.match_date`, [id]),
    sponsors: await ctx.q(
      `SELECT sp.company_name, ss.sponsorship_type, ss.contract_value, ss.start_date, ss.end_date
         FROM season_sponsor ss JOIN sponsor sp ON sp.sponsor_id = ss.sponsor_id
        WHERE ss.season_id = $1 ORDER BY ss.contract_value DESC`, [id]),
    auctions: await ctx.q(
      `SELECT auction_id, auction_date, venue FROM auction WHERE season_id = $1 ORDER BY auction_date`, [id]),
  };
}));

app.post('/api/seasons', route(async (req, ctx) => {
  const b = req.body;
  return ctx.q(
    `INSERT INTO season (season_year, start_date, end_date) VALUES ($1, $2, $3) RETURNING *`,
    [b.season_year, b.start_date, b.end_date]);
}));

// ---------------------------------------------------------------------
// TEAMS
// ---------------------------------------------------------------------
app.get('/api/teams', route(async (req, ctx) => {
  const sid = await seasonOf(req, ctx);
  return {
    teams: await ctx.q(
      `SELECT t.team_id, t.team_name, t.home_city, t.coach_name, t.owner_name, t.founded_year,
              pu.purse_total, pu.purse_spent, pu.purse_remaining, pu.squad_size
         FROM team t
         JOIN v_team_purse pu ON pu.team_id = t.team_id AND pu.season_id = $1
        ORDER BY t.team_name`, [sid]),
    unregistered: await ctx.q(
      `SELECT t.team_id, t.team_name FROM team t
        WHERE NOT EXISTS (SELECT 1 FROM team_season ts WHERE ts.team_id = t.team_id AND ts.season_id = $1)
        ORDER BY t.team_name`, [sid]),
  };
}));

app.get('/api/teams/:id', route(async (req, ctx) => {
  const id = Number(req.params.id);
  const sid = await seasonOf(req, ctx);
  const [team] = await ctx.q('SELECT * FROM team WHERE team_id = $1', [id]);
  if (!team) throw bad('Team not found', 404);
  const squad = await ctx.q(
    `SELECT p.player_id, p.player_name, pt.jersey_no, pt.price, pt.is_captain,
            COALESCE(STRING_AGG(pr.role, ', ' ORDER BY pr.role), '') AS roles
       FROM player_team pt
       JOIN player p ON p.player_id = pt.player_id
       LEFT JOIN player_role pr ON pr.player_id = p.player_id
      WHERE pt.team_id = $1 AND pt.season_id = $2
      GROUP BY p.player_id, p.player_name, pt.jersey_no, pt.price, pt.is_captain
      ORDER BY pt.is_captain DESC, p.player_name`, [id, sid]);
  const matches = await ctx.q(
    `SELECT m.match_id, m.match_date, m.match_type,
            CASE WHEN m.team1_id = $1 THEN t2.team_name ELSE t1.team_name END AS opponent,
            m.status, w.team_name AS winner
       FROM matches m
       JOIN team t1 ON t1.team_id = m.team1_id
       JOIN team t2 ON t2.team_id = m.team2_id
       LEFT JOIN team w ON w.team_id = m.winner_id
      WHERE $1 IN (m.team1_id, m.team2_id) AND m.season_id = $2
      ORDER BY m.match_date`, [id, sid]);
  const [record] = await ctx.q(
    `SELECT COUNT(*) AS played,
            COUNT(*) FILTER (WHERE winner_id = $1) AS won,
            ROUND(100.0 * COUNT(*) FILTER (WHERE winner_id = $1) / NULLIF(COUNT(*), 0), 1) AS win_pct
       FROM matches
      WHERE status = 'Completed' AND $1 IN (team1_id, team2_id) AND season_id = $2`, [id, sid]);
  return { team, squad, matches, record };
}));

app.post('/api/teams', route(async (req, ctx) => {
  const b = req.body;
  return ctx.q(
    `INSERT INTO team (team_name, home_city, coach_name, owner_name, founded_year)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [b.team_name, b.home_city, b.coach_name || null, b.owner_name || null, b.founded_year || null]);
}));

app.post('/api/team_season', route(async (req, ctx) => {
  const b = req.body;
  return ctx.q(
    `INSERT INTO team_season (team_id, season_id, purse_total) VALUES ($1, $2, $3) RETURNING *`,
    [b.team_id, b.season_id, (b.purse_cr || 90) * CR]);
}));

// ---------------------------------------------------------------------
// PLAYERS
// ---------------------------------------------------------------------
app.get('/api/players', route(async (req, ctx) => {
  const sid = await seasonOf(req, ctx);
  const params = [sid];
  const where = [];
  if (req.query.search)      { params.push(`%${req.query.search}%`); where.push(`p.player_name ILIKE $${params.length}`); }
  if (req.query.nationality) { params.push(req.query.nationality);   where.push(`p.nationality = $${params.length}`); }
  if (req.query.role)        {
    params.push(req.query.role);
    where.push(`EXISTS (SELECT 1 FROM player_role r WHERE r.player_id = p.player_id AND r.role = $${params.length})`);
  }
  return {
    players: await ctx.q(
      `SELECT p.player_id, p.player_name, a.age, p.nationality, p.batting_style, p.bowling_style,
              COALESCE((SELECT STRING_AGG(r.role, ', ' ORDER BY r.role)
                          FROM player_role r WHERE r.player_id = p.player_id), '') AS roles,
              t.team_name AS current_team
         FROM player p
         JOIN v_player_age a ON a.player_id = p.player_id
         LEFT JOIN player_team pt ON pt.player_id = p.player_id AND pt.season_id = $1
         LEFT JOIN team t ON t.team_id = pt.team_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY p.player_name`, params),
    nationalities: await ctx.q('SELECT DISTINCT nationality FROM player ORDER BY nationality'),
  };
}));

app.get('/api/players/:id', route(async (req, ctx) => {
  const id = Number(req.params.id);
  const [player] = await ctx.q(
    `SELECT p.*, a.age FROM player p JOIN v_player_age a ON a.player_id = p.player_id WHERE p.player_id = $1`, [id]);
  if (!player) throw bad('Player not found', 404);
  return {
    player,
    roles: await ctx.q('SELECT role FROM player_role WHERE player_id = $1 ORDER BY role', [id]),
    relations: await ctx.q(
      `SELECT 'Mentor' AS relation, p.player_id, p.player_name
         FROM mentor m JOIN player p ON p.player_id = m.mentor_id WHERE m.mentee_id = $1
       UNION ALL
       SELECT 'Mentee', p.player_id, p.player_name
         FROM mentor m JOIN player p ON p.player_id = m.mentee_id WHERE m.mentor_id = $1`, [id]),
    history: await ctx.q(
      `SELECT s.season_year, t.team_name, pt.jersey_no, pt.price, pt.is_captain
         FROM player_team pt
         JOIN season s ON s.season_id = pt.season_id
         JOIN team   t ON t.team_id   = pt.team_id
        WHERE pt.player_id = $1 ORDER BY s.season_year`, [id]),
    career: (await ctx.q(
      `SELECT COUNT(*) AS matches,
              COALESCE(SUM(runs), 0)    AS runs,
              COALESCE(MAX(runs), 0)    AS highest_score,
              COALESCE(SUM(balls), 0)   AS balls_faced,
              CASE WHEN SUM(balls) > 0 THEN ROUND(SUM(runs) * 100.0 / SUM(balls), 2) END AS strike_rate,
              COALESCE(SUM(wickets), 0) AS wickets,
              COALESCE(SUM(catches), 0) AS catches
         FROM match_performance WHERE player_id = $1`, [id]))[0],
  };
}));

app.post('/api/players', route(async (req, ctx) => {
  const b = req.body;
  return ctx.tx(async t => {
    const [p] = await t.q(
      `INSERT INTO player (player_name, dob, nationality, batting_style, bowling_style)
       VALUES ($1, $2, $3, $4, $5) RETURNING player_id`,
      [b.player_name, b.dob, b.nationality, b.batting_style || null, b.bowling_style || null]);
    if ((b.roles || []).length) {
      await t.q(`INSERT INTO player_role (player_id, role) SELECT $1::int, UNNEST($2::text[])`, [p.player_id, b.roles]);
    }
    return p;
  });
}));

app.post('/api/mentor', route(async (req, ctx) => ctx.q(
  `INSERT INTO mentor (mentor_id, mentee_id) VALUES ($1, $2) RETURNING *`,
  [req.body.mentor_id, req.body.mentee_id])));

app.get('/api/player_options', route(async (req, ctx) =>
  ctx.q('SELECT player_id, player_name FROM player ORDER BY player_name')));

// ---------------------------------------------------------------------
// AUCTIONS
// ---------------------------------------------------------------------
app.get('/api/auctions', route(async (req, ctx) => ctx.q(
  `SELECT a.auction_id, s.season_year, a.auction_date, a.venue,
          COUNT(ap.player_id)                                   AS players_in_pool,
          COUNT(ap.player_id) FILTER (WHERE ap.status = 'Sold')    AS sold,
          COUNT(ap.player_id) FILTER (WHERE ap.status = 'Unsold')  AS unsold,
          COUNT(ap.player_id) FILTER (WHERE ap.status = 'Pending') AS pending,
          COALESCE(SUM(ap.sold_price), 0)                       AS total_spent
     FROM auction a
     JOIN season s ON s.season_id = a.season_id
     LEFT JOIN auction_player ap ON ap.auction_id = a.auction_id
    GROUP BY a.auction_id, s.season_year, a.auction_date, a.venue
    ORDER BY a.auction_date DESC`)));

app.post('/api/auctions', route(async (req, ctx) => ctx.q(
  `INSERT INTO auction (season_id, auction_date, venue) VALUES ($1, $2, $3) RETURNING *`,
  [req.body.season_id, req.body.auction_date, req.body.venue])));

app.get('/api/auctions/:id', route(async (req, ctx) => {
  const id = Number(req.params.id);
  const [auction] = await ctx.q(
    `SELECT a.*, s.season_year FROM auction a JOIN season s ON s.season_id = a.season_id WHERE a.auction_id = $1`, [id]);
  if (!auction) throw bad('Auction not found', 404);
  return {
    auction,
    pool: await ctx.q(
      `SELECT ap.player_id, p.player_name, p.nationality, ap.base_price, ap.status, ap.sold_price, t.team_name
         FROM auction_player ap
         JOIN player p ON p.player_id = ap.player_id
         LEFT JOIN team t ON t.team_id = ap.team_id
        WHERE ap.auction_id = $1
        ORDER BY CASE ap.status WHEN 'Pending' THEN 0 WHEN 'Sold' THEN 1 ELSE 2 END, p.player_name`, [id]),
    purses: await ctx.q(
      `SELECT team_id, team_name, purse_total, purse_spent, purse_remaining, squad_size
         FROM v_team_purse WHERE season_id = $1 ORDER BY team_name`, [auction.season_id]),
    addable: await ctx.q(
      `SELECT p.player_id, p.player_name FROM player p
        WHERE NOT EXISTS (SELECT 1 FROM auction_player ap WHERE ap.auction_id = $1 AND ap.player_id = p.player_id)
        ORDER BY p.player_name`, [id]),
  };
}));

app.post('/api/auctions/:id/pool', route(async (req, ctx) => ctx.q(
  `INSERT INTO auction_player (auction_id, player_id, base_price) VALUES ($1, $2, $3) RETURNING *`,
  [req.params.id, req.body.player_id, req.body.base_price_cr * CR])));

app.post('/api/auctions/:id/sell', route(async (req, ctx) =>
  ctx.q('CALL sell_player($1, $2, $3, $4)',
        [req.params.id, req.body.player_id, req.body.team_id, req.body.price_cr * CR])));

app.post('/api/auctions/:id/unsold', route(async (req, ctx) =>
  ctx.q('CALL mark_unsold($1, $2)', [req.params.id, req.body.player_id])));

// ---------------------------------------------------------------------
// MATCHES
// ---------------------------------------------------------------------
app.get('/api/matches', route(async (req, ctx) => {
  const sid = await seasonOf(req, ctx);
  const params = [sid];
  const where = ['m.season_id = $1'];
  if (req.query.team)   { params.push(Number(req.query.team));   where.push(`(m.team1_id = $${params.length} OR m.team2_id = $${params.length})`); }
  if (req.query.type)   { params.push(req.query.type);           where.push(`m.match_type = $${params.length}`); }
  if (req.query.status) { params.push(req.query.status);         where.push(`m.status = $${params.length}`); }
  return {
    matches: await ctx.q(
      `SELECT m.match_id, m.match_date, TO_CHAR(m.match_time, 'HH24:MI') AS match_time, m.match_type,
              t1.team_name AS team1, t2.team_name AS team2, st.stadium_name,
              m.status, w.team_name AS winner, m.result_text
         FROM matches m
         JOIN team t1 ON t1.team_id = m.team1_id
         JOIN team t2 ON t2.team_id = m.team2_id
         JOIN stadium st ON st.stadium_id = m.stadium_id
         LEFT JOIN team w ON w.team_id = m.winner_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.match_date, m.match_time`, params),
    teams: await ctx.q(
      `SELECT t.team_id, t.team_name FROM team t
         JOIN team_season ts ON ts.team_id = t.team_id AND ts.season_id = $1 ORDER BY t.team_name`, [sid]),
    season_id: sid,
  };
}));

app.get('/api/matches/:id', route(async (req, ctx) => {
  const id = Number(req.params.id);
  const [match] = await ctx.q(
    `SELECT m.match_id, m.season_id, s.season_year, m.match_date, TO_CHAR(m.match_time, 'HH24:MI') AS match_time,
            m.match_type, m.status, m.result_text, m.stadium_id,
            m.team1_id, t1.team_name AS team1, m.team2_id, t2.team_name AS team2,
            st.stadium_name, st.city, tw.team_name AS toss_winner, w.team_name AS winner,
            mom.player_name AS man_of_match
       FROM matches m
       JOIN season  s  ON s.season_id   = m.season_id
       JOIN team    t1 ON t1.team_id    = m.team1_id
       JOIN team    t2 ON t2.team_id    = m.team2_id
       JOIN stadium st ON st.stadium_id = m.stadium_id
       LEFT JOIN team   tw  ON tw.team_id    = m.toss_winner_id
       LEFT JOIN team   w   ON w.team_id     = m.winner_id
       LEFT JOIN player mom ON mom.player_id = m.man_of_match_id
      WHERE m.match_id = $1`, [id]);
  if (!match) throw bad('Match not found', 404);
  return {
    match,
    stadiums: await ctx.q('SELECT stadium_id, stadium_name FROM stadium ORDER BY stadium_name'),
    umpires: await ctx.q(
      `SELECT u.umpire_id, u.umpire_name, u.nationality, mu.role, mu.fee
         FROM match_umpire mu JOIN umpire u ON u.umpire_id = mu.umpire_id
        WHERE mu.match_id = $1
        ORDER BY CASE mu.role WHEN 'On-field' THEN 0 WHEN 'Third' THEN 1 ELSE 2 END, u.umpire_name`, [id]),
    performance: await ctx.q(
      `SELECT mp.player_id, p.player_name, t.team_name, mp.runs, mp.balls, mp.strike_rate,
              mp.wickets, mp.overs, mp.runs_conceded, mp.economy, mp.catches
         FROM match_performance mp
         JOIN player p ON p.player_id = mp.player_id
         JOIN player_team pt ON pt.player_id = mp.player_id AND pt.season_id = $2
         JOIN team t ON t.team_id = pt.team_id
        WHERE mp.match_id = $1
        ORDER BY t.team_name, mp.runs DESC`, [id, match.season_id]),
    eligible: await ctx.q(
      `SELECT p.player_id, p.player_name, t.team_name
         FROM player_team pt
         JOIN player p ON p.player_id = pt.player_id
         JOIN team   t ON t.team_id   = pt.team_id
        WHERE pt.season_id = $1 AND pt.team_id IN ($2, $3)
        ORDER BY t.team_name, p.player_name`, [match.season_id, match.team1_id, match.team2_id]),
  };
}));

app.post('/api/matches', route(async (req, ctx) => {
  const b = req.body;
  const [r] = await ctx.q(
    `SELECT schedule_match($1, $2, $3, $4, $5, $6, $7, $8::int[], $9, $10) AS match_id`,
    [b.season_id, b.stadium_id, b.match_date, b.match_time, b.match_type, b.team1_id, b.team2_id,
     b.umpires || [], b.third_umpire || null, b.fee || 150000]);
  return r;
}));

app.post('/api/matches/:id/result', route(async (req, ctx) => {
  const b = req.body;
  await ctx.q('CALL record_result($1, $2, $3, $4)',
              [req.params.id, b.toss_winner_id || null, b.winner_id || null, b.result_text || null]);
  return { ok: true };
}));

app.post('/api/matches/:id/performance', route(async (req, ctx) => {
  const b = req.body;
  return ctx.q(
    `INSERT INTO match_performance (match_id, player_id, runs, balls, wickets, overs, runs_conceded, catches)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (match_id, player_id) DO UPDATE
        SET runs = EXCLUDED.runs, balls = EXCLUDED.balls, wickets = EXCLUDED.wickets,
            overs = EXCLUDED.overs, runs_conceded = EXCLUDED.runs_conceded, catches = EXCLUDED.catches
     RETURNING *`,
    [req.params.id, b.player_id, b.runs || 0, b.balls || 0, b.wickets || 0, b.overs || 0,
     b.runs_conceded || 0, b.catches || 0]);
}));

app.post('/api/matches/:id/mom', route(async (req, ctx) => ctx.q(
  `UPDATE matches SET man_of_match_id = $2 WHERE match_id = $1 RETURNING match_id, man_of_match_id`,
  [req.params.id, req.body.player_id])));

// ---------------------------------------------------------------------
// STADIUMS / UMPIRES
// ---------------------------------------------------------------------
app.get('/api/stadiums', route(async (req, ctx) => ctx.q(
  `SELECT s.stadium_id, s.stadium_name, s.city, s.capacity, s.pitch_type,
          COUNT(m.match_id)                                         AS matches_hosted,
          COUNT(m.match_id) FILTER (WHERE m.toss_winner_id = m.winner_id) AS toss_winner_won,
          ROUND(100.0 * COUNT(m.match_id) FILTER (WHERE m.toss_winner_id = m.winner_id)
                / NULLIF(COUNT(m.match_id), 0), 0)                  AS toss_winner_won_pct
     FROM stadium s
     LEFT JOIN matches m ON m.stadium_id = s.stadium_id AND m.status = 'Completed'
    GROUP BY s.stadium_id
    ORDER BY s.stadium_name`)));

app.post('/api/stadiums', route(async (req, ctx) => ctx.q(
  `INSERT INTO stadium (stadium_name, city, capacity, pitch_type) VALUES ($1, $2, $3, $4) RETURNING *`,
  [req.body.stadium_name, req.body.city, req.body.capacity, req.body.pitch_type || null])));

app.get('/api/umpires', route(async (req, ctx) => ctx.q(
  `SELECT u.umpire_id, u.umpire_name, u.nationality, u.experience_years,
          COUNT(mu.match_id)               AS matches_officiated,
          COALESCE(SUM(mu.fee), 0)         AS total_fee
     FROM umpire u
     LEFT JOIN match_umpire mu ON mu.umpire_id = u.umpire_id
    GROUP BY u.umpire_id
    ORDER BY total_fee DESC, u.umpire_name`)));

app.post('/api/umpires', route(async (req, ctx) => ctx.q(
  `INSERT INTO umpire (umpire_name, nationality, experience_years) VALUES ($1, $2, $3) RETURNING *`,
  [req.body.umpire_name, req.body.nationality, req.body.experience_years || 0])));

// ---------------------------------------------------------------------
// SPONSORS
// ---------------------------------------------------------------------
app.get('/api/sponsors', route(async (req, ctx) => {
  const sid = await seasonOf(req, ctx);
  return {
    sponsors: await ctx.q(
      `SELECT sp.sponsor_id, sp.company_name,
              COALESCE((SELECT STRING_AGG(i.industry, ', ' ORDER BY i.industry)
                          FROM sponsor_industry i WHERE i.sponsor_id = sp.sponsor_id), '') AS industries,
              COALESCE(SUM(ss.contract_value), 0) AS lifetime_value,
              COUNT(ss.season_id)                 AS seasons_sponsored
         FROM sponsor sp
         LEFT JOIN season_sponsor ss ON ss.sponsor_id = sp.sponsor_id
        GROUP BY sp.sponsor_id
        ORDER BY sp.company_name`),
    contracts: await ctx.q(
      `SELECT ss.season_id, ss.sponsor_id, sp.company_name, ss.sponsorship_type, ss.contract_value, ss.start_date, ss.end_date
         FROM season_sponsor ss JOIN sponsor sp ON sp.sponsor_id = ss.sponsor_id
        WHERE ss.season_id = $1 ORDER BY ss.contract_value DESC`, [sid]),
    options: await ctx.q('SELECT sponsor_id, company_name FROM sponsor ORDER BY company_name'),
  };
}));

app.post('/api/sponsors', route(async (req, ctx) => {
  const b = req.body;
  return ctx.tx(async t => {
    const [s] = await t.q(`INSERT INTO sponsor (company_name) VALUES ($1) RETURNING sponsor_id`, [b.company_name]);
    const inds = String(b.industries || '').split(',').map(x => x.trim()).filter(Boolean);
    if (inds.length) {
      await t.q(`INSERT INTO sponsor_industry (sponsor_id, industry) SELECT $1::int, UNNEST($2::text[])`, [s.sponsor_id, inds]);
    }
    return s;
  });
}));

app.post('/api/season_sponsor', route(async (req, ctx) => {
  const b = req.body;
  return ctx.q(
    `INSERT INTO season_sponsor (season_id, sponsor_id, sponsorship_type, contract_value, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [b.season_id, b.sponsor_id, b.sponsorship_type, b.contract_cr * CR, b.start_date, b.end_date]);
}));


// ---------------------------------------------------------------------
// UPDATE / DELETE
// ---------------------------------------------------------------------
const del = (sql, params) => route(async (req, ctx) => {
  const rows = await ctx.q(sql, params(req));
  if (!rows.length) throw bad('Nothing to delete (already removed?)', 404);
  return { deleted: rows.length };
});
const upd = (sql, params) => route(async (req, ctx) => {
  const rows = await ctx.q(sql, params(req));
  if (!rows.length) throw bad('Record not found', 404);
  return rows[0];
});

app.put('/api/seasons/:id', upd(
  `UPDATE season SET season_year = $2, start_date = $3, end_date = $4 WHERE season_id = $1 RETURNING *`,
  r => [r.params.id, r.body.season_year, r.body.start_date, r.body.end_date]));
app.delete('/api/seasons/:id', del(`DELETE FROM season WHERE season_id = $1 RETURNING season_id`, r => [r.params.id]));

app.put('/api/teams/:id', upd(
  `UPDATE team SET team_name = $2, home_city = $3, coach_name = $4, owner_name = $5, founded_year = $6
    WHERE team_id = $1 RETURNING *`,
  r => [r.params.id, r.body.team_name, r.body.home_city, r.body.coach_name || null, r.body.owner_name || null, r.body.founded_year || null]));
app.delete('/api/teams/:id', del(`DELETE FROM team WHERE team_id = $1 RETURNING team_id`, r => [r.params.id]));

app.put('/api/team_season/:team/:season', upd(
  `UPDATE team_season SET purse_total = $3 WHERE team_id = $1 AND season_id = $2 RETURNING *`,
  r => [r.params.team, r.params.season, r.body.purse_cr * CR]));
app.delete('/api/team_season/:team/:season', del(
  `DELETE FROM team_season WHERE team_id = $1 AND season_id = $2 RETURNING team_id`, r => [r.params.team, r.params.season]));

app.put('/api/players/:id', route(async (req, ctx) => {
  const b = req.body, id = Number(req.params.id);
  return ctx.tx(async t => {
    const [p] = await t.q(
      `UPDATE player SET player_name = $2, dob = $3, nationality = $4, batting_style = $5, bowling_style = $6
        WHERE player_id = $1 RETURNING player_id`,
      [id, b.player_name, b.dob, b.nationality, b.batting_style || null, b.bowling_style || null]);
    if (!p) throw bad('Player not found', 404);
    await t.q('DELETE FROM player_role WHERE player_id = $1', [id]);
    if ((b.roles || []).length) {
      await t.q(`INSERT INTO player_role (player_id, role) SELECT $1::int, UNNEST($2::text[])`, [id, b.roles]);
    }
    return p;
  });
}));
app.delete('/api/players/:id', del(`DELETE FROM player WHERE player_id = $1 RETURNING player_id`, r => [r.params.id]));

app.delete('/api/mentor/:mentor/:mentee', del(
  `DELETE FROM mentor WHERE mentor_id = $1 AND mentee_id = $2 RETURNING mentor_id`, r => [r.params.mentor, r.params.mentee]));

app.put('/api/auctions/:id', upd(
  `UPDATE auction SET auction_date = $2, venue = $3 WHERE auction_id = $1 RETURNING *`,
  r => [r.params.id, r.body.auction_date, r.body.venue]));
app.delete('/api/auctions/:id', route(async (req, ctx) => {
  const [sold] = await ctx.q(`SELECT COUNT(*) AS n FROM auction_player WHERE auction_id = $1 AND status = 'Sold'`, [req.params.id]);
  if (sold.n) throw bad('Undo the sales in this auction before deleting it');
  const rows = await ctx.q('DELETE FROM auction WHERE auction_id = $1 RETURNING auction_id', [req.params.id]);
  if (!rows.length) throw bad('Auction not found', 404);
  return { deleted: 1 };
}));
app.put('/api/auctions/:id/pool/:player', upd(
  `UPDATE auction_player SET base_price = $3 WHERE auction_id = $1 AND player_id = $2 AND status <> 'Sold' RETURNING *`,
  r => [r.params.id, r.params.player, r.body.base_price_cr * CR]));
app.delete('/api/auctions/:id/pool/:player', del(
  `DELETE FROM auction_player WHERE auction_id = $1 AND player_id = $2 AND status <> 'Sold' RETURNING player_id`,
  r => [r.params.id, r.params.player]));

app.put('/api/matches/:id', upd(
  `UPDATE matches SET stadium_id = $2, match_date = $3, match_time = $4, match_type = $5
    WHERE match_id = $1 RETURNING *`,
  r => [r.params.id, r.body.stadium_id, r.body.match_date, r.body.match_time, r.body.match_type]));
app.delete('/api/matches/:id', del(`DELETE FROM matches WHERE match_id = $1 RETURNING match_id`, r => [r.params.id]));
app.delete('/api/matches/:id/performance/:player', route(async (req, ctx) => ctx.tx(async t => {
  await t.q('UPDATE matches SET man_of_match_id = NULL WHERE match_id = $1 AND man_of_match_id = $2', [req.params.id, req.params.player]);
  const rows = await t.q('DELETE FROM match_performance WHERE match_id = $1 AND player_id = $2 RETURNING player_id',
                         [req.params.id, req.params.player]);
  if (!rows.length) throw bad('Performance row not found', 404);
  return { deleted: 1 };
})));

app.put('/api/matches/:id/umpires/:umpire', upd(
  `UPDATE match_umpire SET fee = $3 WHERE match_id = $1 AND umpire_id = $2 RETURNING *`,
  r => [r.params.id, r.params.umpire, r.body.fee]));

app.put('/api/stadiums/:id', upd(
  `UPDATE stadium SET stadium_name = $2, city = $3, capacity = $4, pitch_type = $5 WHERE stadium_id = $1 RETURNING *`,
  r => [r.params.id, r.body.stadium_name, r.body.city, r.body.capacity, r.body.pitch_type || null]));
app.delete('/api/stadiums/:id', del(`DELETE FROM stadium WHERE stadium_id = $1 RETURNING stadium_id`, r => [r.params.id]));

app.put('/api/umpires/:id', upd(
  `UPDATE umpire SET umpire_name = $2, nationality = $3, experience_years = $4 WHERE umpire_id = $1 RETURNING *`,
  r => [r.params.id, r.body.umpire_name, r.body.nationality, r.body.experience_years || 0]));
app.delete('/api/umpires/:id', del(`DELETE FROM umpire WHERE umpire_id = $1 RETURNING umpire_id`, r => [r.params.id]));

app.put('/api/sponsors/:id', route(async (req, ctx) => {
  const b = req.body, id = Number(req.params.id);
  return ctx.tx(async t => {
    const [s] = await t.q(`UPDATE sponsor SET company_name = $2 WHERE sponsor_id = $1 RETURNING sponsor_id`, [id, b.company_name]);
    if (!s) throw bad('Sponsor not found', 404);
    await t.q('DELETE FROM sponsor_industry WHERE sponsor_id = $1', [id]);
    const inds = [...new Set(String(b.industries || '').split(',').map(x => x.trim()).filter(Boolean))];
    if (inds.length) {
      await t.q(`INSERT INTO sponsor_industry (sponsor_id, industry) SELECT $1::int, UNNEST($2::text[])`, [id, inds]);
    }
    return s;
  });
}));
app.delete('/api/sponsors/:id', del(`DELETE FROM sponsor WHERE sponsor_id = $1 RETURNING sponsor_id`, r => [r.params.id]));

app.put('/api/season_sponsor/:season/:sponsor', upd(
  `UPDATE season_sponsor SET sponsorship_type = $3, contract_value = $4, start_date = $5, end_date = $6
    WHERE season_id = $1 AND sponsor_id = $2 RETURNING *`,
  r => [r.params.season, r.params.sponsor, r.body.sponsorship_type, r.body.contract_cr * CR, r.body.start_date, r.body.end_date]));
app.delete('/api/season_sponsor/:season/:sponsor', del(
  `DELETE FROM season_sponsor WHERE season_id = $1 AND sponsor_id = $2 RETURNING sponsor_id`, r => [r.params.season, r.params.sponsor]));

// ---------------------------------------------------------------------
// REPORTS  (ready-made queries, each shows a different SQL concept)
// ---------------------------------------------------------------------
const REPORTS = [
  { key: 'multi-team', title: 'Players who played for more than one team', concept: 'GROUP BY + HAVING',
    sql: `SELECT p.player_name,
       COUNT(DISTINCT pt.team_id)            AS teams_played_for,
       STRING_AGG(DISTINCT t.team_name, ', ') AS teams
  FROM player p
  JOIN player_team pt ON pt.player_id = p.player_id
  JOIN team t         ON t.team_id    = pt.team_id
 GROUP BY p.player_id, p.player_name
HAVING COUNT(DISTINCT pt.team_id) > 1` },
  { key: 'never-won', title: 'Teams that played at a stadium but never won there', concept: 'EXISTS / NOT EXISTS',
    sql: `SELECT t.team_name, s.stadium_name
  FROM team t CROSS JOIN stadium s
 WHERE EXISTS (SELECT 1 FROM matches m
                WHERE m.stadium_id = s.stadium_id
                  AND t.team_id IN (m.team1_id, m.team2_id)
                  AND m.status = 'Completed')
   AND NOT EXISTS (SELECT 1 FROM matches m
                    WHERE m.stadium_id = s.stadium_id
                      AND m.winner_id  = t.team_id)
 ORDER BY s.stadium_name, t.team_name` },
  { key: 'priciest', title: 'Most expensive signing in each season', concept: 'Correlated subquery',
    sql: `SELECT s.season_year, p.player_name, t.team_name, pt.price
  FROM player_team pt
  JOIN season s ON s.season_id = pt.season_id
  JOIN player p ON p.player_id = pt.player_id
  JOIN team   t ON t.team_id   = pt.team_id
 WHERE pt.price = (SELECT MAX(x.price)
                     FROM player_team x
                    WHERE x.season_id = pt.season_id)
 ORDER BY s.season_year` },
  { key: 'never-sold', title: 'Players never sold at any auction', concept: 'LEFT JOIN ... IS NULL (anti-join)',
    sql: `SELECT p.player_name
  FROM player p
  LEFT JOIN auction_player ap
         ON ap.player_id = p.player_id AND ap.status = 'Sold'
 WHERE ap.player_id IS NULL
 ORDER BY p.player_name` },
  { key: 'sponsor-revenue', title: 'Sponsorship revenue per season (with grand total)', concept: 'GROUP BY ROLLUP',
    sql: `SELECT COALESCE(s.season_year::text, 'ALL SEASONS') AS season,
       COUNT(*)                 AS contracts,
       SUM(ss.contract_value)   AS revenue
  FROM season_sponsor ss
  JOIN season s ON s.season_id = ss.season_id
 GROUP BY ROLLUP (s.season_year)
 ORDER BY s.season_year NULLS LAST` },
  { key: 'run-rank', title: 'Run-scoring rank within each season', concept: 'Window function RANK() OVER (PARTITION BY ...)',
    sql: `SELECT season_year, player_name, total_runs,
       RANK() OVER (PARTITION BY season_year ORDER BY total_runs DESC) AS run_rank
  FROM v_player_season_stats
 ORDER BY season_year, run_rank` },
  { key: 'above-avg', title: 'Players with more career runs than the average player', concept: 'Subquery in HAVING',
    sql: `SELECT p.player_name, SUM(mp.runs) AS career_runs
  FROM match_performance mp
  JOIN player p ON p.player_id = mp.player_id
 GROUP BY p.player_id, p.player_name
HAVING SUM(mp.runs) > (SELECT AVG(r)
                         FROM (SELECT SUM(runs) AS r
                                 FROM match_performance
                                GROUP BY player_id) per_player)
 ORDER BY career_runs DESC` },
  { key: 'win-pct', title: 'All-time win percentage of each team', concept: 'CTE (WITH) + UNION ALL + FILTER',
    sql: `WITH appearances AS (
  SELECT team1_id AS team_id, winner_id FROM matches WHERE status = 'Completed'
  UNION ALL
  SELECT team2_id,            winner_id FROM matches WHERE status = 'Completed'
)
SELECT t.team_name,
       COUNT(*)                                      AS played,
       COUNT(*) FILTER (WHERE a.winner_id = a.team_id) AS won,
       ROUND(100.0 * COUNT(*) FILTER (WHERE a.winner_id = a.team_id) / COUNT(*), 1) AS win_pct
  FROM appearances a
  JOIN team t ON t.team_id = a.team_id
 GROUP BY t.team_id, t.team_name
 ORDER BY win_pct DESC, t.team_name` },
  { key: 'umpire-fees', title: 'Umpire fees earned', concept: 'JOIN + SUM / AVG aggregates',
    sql: `SELECT u.umpire_name,
       COUNT(*)            AS matches,
       SUM(mu.fee)         AS total_fee,
       ROUND(AVG(mu.fee))  AS avg_fee
  FROM umpire u
  JOIN match_umpire mu ON mu.umpire_id = u.umpire_id
 GROUP BY u.umpire_id, u.umpire_name
 ORDER BY total_fee DESC` },
  { key: 'integrity', title: 'Integrity check: matches with fewer than 2 on-field umpires', concept: 'Data validation (should return 0 rows)',
    sql: `SELECT m.match_id, m.match_date,
       COUNT(mu.umpire_id) FILTER (WHERE mu.role = 'On-field') AS on_field_umpires
  FROM matches m
  LEFT JOIN match_umpire mu ON mu.match_id = m.match_id
 GROUP BY m.match_id, m.match_date
HAVING COUNT(mu.umpire_id) FILTER (WHERE mu.role = 'On-field') < 2` },
];

app.get('/api/reports', (req, res) =>
  res.json({ data: REPORTS.map(({ key, title, concept }) => ({ key, title, concept })), queries: [] }));

app.get('/api/reports/:key', route(async (req, ctx) => {
  const r = REPORTS.find(x => x.key === req.params.key);
  if (!r) throw bad('Unknown report', 404);
  return { title: r.title, concept: r.concept, rows: await ctx.q(r.sql) };
}));

// ---------------------------------------------------------------------
// SQL CONSOLE  (SELECT only, runs inside a READ ONLY transaction)
// ---------------------------------------------------------------------
app.post('/api/console', route(async (req, ctx) => {
  const sql = String(req.body.sql || '').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(sql)) throw bad('Only SELECT queries are allowed in the console');
  if (sql.includes(';')) throw bad('Only one statement at a time');
  if (/\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|pg_sleep|set_config|pg_terminate_backend)\b/i.test(sql)) {
    throw bad('That function is not allowed in the console');
  }
  ctx.log.push({ text: 'BEGIN READ ONLY' }, { text: sql });
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query('SET LOCAL statement_timeout = 3000');
    const r = await c.query(sql);
    return { rows: r.rows.slice(0, 500), truncated: r.rows.length > 500 };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}));

// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
pool.query('SELECT 1').then(() => {
  app.listen(PORT, () => console.log(`IPL Management System running at http://localhost:${PORT}`));
}).catch(e => {
  console.error('Cannot connect to PostgreSQL:', e.message);
  console.error('Check DATABASE_URL in your .env file, and run:  npm run db:setup');
  process.exit(1);
});
