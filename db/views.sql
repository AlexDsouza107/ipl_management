-- =====================================================================
--  IPL MANAGEMENT SYSTEM  -  views.sql   (PostgreSQL 14+)
--  Run AFTER schema.sql and triggers.sql.
--  Views hold everything that is DERIVED, so nothing is stored twice.
-- =====================================================================

-- Player with computed age
CREATE OR REPLACE VIEW v_player_age AS
SELECT player_id,
       player_name,
       dob,
       nationality,
       DATE_PART('year', AGE(CURRENT_DATE, dob))::INT AS age
FROM   player;

-- Squad of every team in every season
CREATE OR REPLACE VIEW v_squad AS
SELECT s.season_year,
       t.team_name,
       p.player_id,
       p.player_name,
       pt.jersey_no,
       pt.price,
       pt.is_captain,
       STRING_AGG(pr.role, ', ' ORDER BY pr.role) AS roles
FROM   player_team pt
JOIN   season s ON s.season_id = pt.season_id
JOIN   team   t ON t.team_id   = pt.team_id
JOIN   player p ON p.player_id = pt.player_id
LEFT   JOIN player_role pr ON pr.player_id = p.player_id
GROUP  BY s.season_year, t.team_name, p.player_id, p.player_name,
          pt.jersey_no, pt.price, pt.is_captain;

-- Purse: total, spent, remaining (derived, never stored)
CREATE OR REPLACE VIEW v_team_purse AS
SELECT ts.season_id,
       s.season_year,
       ts.team_id,
       t.team_name,
       ts.purse_total,
       COALESCE(SUM(pt.price), 0)                    AS purse_spent,
       ts.purse_total - COALESCE(SUM(pt.price), 0)   AS purse_remaining,
       COUNT(pt.player_id)                           AS squad_size
FROM   team_season ts
JOIN   season s ON s.season_id = ts.season_id
JOIN   team   t ON t.team_id   = ts.team_id
LEFT   JOIN player_team pt
       ON pt.team_id = ts.team_id AND pt.season_id = ts.season_id
GROUP  BY ts.season_id, s.season_year, ts.team_id, t.team_name, ts.purse_total;

-- Points table (league stage): win = 2, no result = 1, loss = 0
CREATE OR REPLACE VIEW v_points_table AS
WITH tally AS (
    SELECT ts.season_id,
           ts.team_id,
           COUNT(m.match_id) FILTER (WHERE m.status <> 'Scheduled')                 AS played,
           COUNT(m.match_id) FILTER (WHERE m.winner_id = ts.team_id)                AS won,
           COUNT(m.match_id) FILTER (WHERE m.status = 'Completed'
                                       AND m.winner_id <> ts.team_id)               AS lost,
           COUNT(m.match_id) FILTER (WHERE m.status = 'No Result')                  AS no_result
    FROM   team_season ts
    LEFT   JOIN matches m
           ON  m.season_id = ts.season_id
           AND m.match_type = 'League'
           AND ts.team_id IN (m.team1_id, m.team2_id)
    GROUP  BY ts.season_id, ts.team_id
)
SELECT s.season_year,
       t.team_name,
       k.played, k.won, k.lost, k.no_result,
       (k.won * 2 + k.no_result)                                   AS points,
       RANK() OVER (PARTITION BY k.season_id
                    ORDER BY (k.won * 2 + k.no_result) DESC, k.won DESC) AS position
FROM   tally k
JOIN   season s ON s.season_id = k.season_id
JOIN   team   t ON t.team_id   = k.team_id;

-- Batting + bowling totals per player per season
CREATE OR REPLACE VIEW v_player_season_stats AS
SELECT s.season_year,
       p.player_id,
       p.player_name,
       COUNT(*)                                         AS matches_played,
       SUM(mp.runs)                                     AS total_runs,
       SUM(mp.balls)                                    AS balls_faced,
       CASE WHEN SUM(mp.balls) > 0
            THEN ROUND(SUM(mp.runs) * 100.0 / SUM(mp.balls), 2) END AS strike_rate,
       SUM(mp.wickets)                                  AS total_wickets,
       SUM(mp.catches)                                  AS total_catches
FROM   match_performance mp
JOIN   matches m ON m.match_id  = mp.match_id
JOIN   season  s ON s.season_id = m.season_id
JOIN   player  p ON p.player_id = mp.player_id
GROUP  BY s.season_year, p.player_id, p.player_name;

-- Full match list with names instead of ids
CREATE OR REPLACE VIEW v_match_details AS
SELECT m.match_id,
       s.season_year,
       m.match_date,
       m.match_time,
       m.match_type,
       t1.team_name AS team1,
       t2.team_name AS team2,
       st.stadium_name,
       st.city,
       tw.team_name AS toss_winner,
       w.team_name  AS winner,
       m.status,
       m.result_text
FROM   matches m
JOIN   season  s  ON s.season_id   = m.season_id
JOIN   team    t1 ON t1.team_id    = m.team1_id
JOIN   team    t2 ON t2.team_id    = m.team2_id
JOIN   stadium st ON st.stadium_id = m.stadium_id
LEFT   JOIN team tw ON tw.team_id  = m.toss_winner_id
LEFT   JOIN team w  ON w.team_id   = m.winner_id;
