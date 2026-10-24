-- =====================================================================
--  IPL MANAGEMENT SYSTEM  -  seed.sql   (PostgreSQL 14+)
--  Run AFTER schema.sql, triggers.sql, views.sql.
--
--  Small sample set:  4 teams | 2 seasons (2023, 2024) | 8 players
--                     4 stadiums | 4 umpires | 2 sponsors | 6 matches
--
--  NOTE: names are real, but dates of birth aside, ALL prices, results
--  and scores are made up for the demo. Do not treat them as real IPL data.
--
--  The data goes in through the real routines (sell_player,
--  schedule_match, record_result), so it also exercises your triggers.
-- =====================================================================
BEGIN;

-- ---- seasons / teams / stadiums -------------------------------------
INSERT INTO season (season_id, season_year, start_date, end_date) VALUES
 (1, 2023, '2023-03-31', '2023-05-29'),
 (2, 2024, '2024-03-22', '2024-05-26');

INSERT INTO team (team_id, team_name, home_city, coach_name, owner_name, founded_year) VALUES
 (1, 'Chennai Super Kings',       'Chennai',   'Stephen Fleming', 'India Cements',  2008),
 (2, 'Mumbai Indians',            'Mumbai',    'Mark Boucher',    'Reliance',       2008),
 (3, 'Royal Challengers Bengaluru','Bengaluru','Andy Flower',     'United Spirits', 2008),
 (4, 'Kolkata Knight Riders',     'Kolkata',   'Chandrakant Pandit','Red Chillies', 2008);

-- all 4 teams take part in both seasons (default purse = 90 crore)
INSERT INTO team_season (team_id, season_id) VALUES
 (1,1),(2,1),(3,1),(4,1),
 (1,2),(2,2),(3,2),(4,2);

INSERT INTO stadium (stadium_id, stadium_name, city, capacity, pitch_type) VALUES
 (1, 'MA Chidambaram Stadium', 'Chennai',   50000, 'Spin-friendly'),
 (2, 'Wankhede Stadium',       'Mumbai',    33000, 'Batting'),
 (3, 'M Chinnaswamy Stadium',  'Bengaluru', 40000, 'Batting'),
 (4, 'Eden Gardens',           'Kolkata',   66000, 'Balanced');

-- ---- players ---------------------------------------------------------
INSERT INTO player (player_id, player_name, dob, nationality, batting_style, bowling_style) VALUES
 (1, 'MS Dhoni',        '1981-07-07', 'India',       'Right-hand', NULL),
 (2, 'Ravindra Jadeja', '1988-12-06', 'India',       'Left-hand',  'Left-arm orthodox'),
 (3, 'Rohit Sharma',    '1987-04-30', 'India',       'Right-hand', 'Right-arm off-break'),
 (4, 'Jasprit Bumrah',  '1993-12-06', 'India',       'Right-hand', 'Right-arm fast'),
 (5, 'Virat Kohli',     '1988-11-05', 'India',       'Right-hand', 'Right-arm medium'),
 (6, 'Mohammed Siraj',  '1994-03-13', 'India',       'Right-hand', 'Right-arm fast'),
 (7, 'Andre Russell',   '1988-04-29', 'West Indies', 'Right-hand', 'Right-arm fast'),
 (8, 'Sunil Narine',    '1988-05-26', 'West Indies', 'Left-hand',  'Right-arm off-break');

INSERT INTO player_role (player_id, role) VALUES
 (1,'Wicket-keeper'),(1,'Batter'),
 (2,'All-rounder'),
 (3,'Batter'),
 (4,'Bowler'),
 (5,'Batter'),
 (6,'Bowler'),
 (7,'All-rounder'),
 (8,'All-rounder');

INSERT INTO mentor (mentor_id, mentee_id, start_date) VALUES
 (1, 2, '2023-01-01');          -- Dhoni mentors Jadeja

-- ---- auctions --------------------------------------------------------
INSERT INTO auction (auction_id, season_id, auction_date, venue) VALUES
 (1, 1, '2022-12-23', 'Kochi'),
 (2, 2, '2023-12-19', 'Dubai');

-- 2023: all 8 players are in the pool, base price Rs 2 crore each
INSERT INTO auction_player (auction_id, player_id, base_price)
SELECT 1, player_id, 20000000 FROM player;

CALL sell_player(1, 1, 1, 120000000);   -- Dhoni   -> CSK
CALL sell_player(1, 2, 1, 160000000);   -- Jadeja  -> CSK
CALL sell_player(1, 3, 2, 160000000);   -- Rohit   -> MI
CALL sell_player(1, 4, 2, 120000000);   -- Bumrah  -> MI
CALL sell_player(1, 5, 3, 150000000);   -- Kohli   -> RCB
CALL sell_player(1, 6, 3,  70000000);   -- Siraj   -> RCB
CALL sell_player(1, 7, 4, 120000000);   -- Russell -> KKR
CALL sell_player(1, 8, 4,  60000000);   -- Narine  -> KKR

-- 2024: six players are retained by their teams (direct signing) ...
INSERT INTO player_team (player_id, season_id, team_id, jersey_no, price, is_captain) VALUES
 (1, 2, 1,  7, 120000000, TRUE),   -- Dhoni   CSK
 (2, 2, 1,  8, 160000000, FALSE),  -- Jadeja  CSK
 (3, 2, 2, 45, 160000000, TRUE),   -- Rohit   MI
 (4, 2, 2, 93, 120000000, FALSE),  -- Bumrah  MI
 (5, 2, 3, 18, 150000000, TRUE),   -- Kohli   RCB
 (8, 2, 4, 74,  60000000, TRUE);   -- Narine  KKR

-- ... and two players swap teams through the auction
INSERT INTO auction_player (auction_id, player_id, base_price) VALUES
 (2, 7, 20000000),
 (2, 6, 20000000);
CALL sell_player(2, 7, 3, 80000000);    -- Russell KKR -> RCB
CALL sell_player(2, 6, 4, 60000000);    -- Siraj   RCB -> KKR

-- jersey numbers / captains for the 2023 squads and the two 2024 buys
UPDATE player_team pt
   SET jersey_no = v.jersey, is_captain = v.cap
  FROM (VALUES (1,1, 7,TRUE ),(2,1, 8,FALSE),(3,1,45,TRUE ),(4,1,93,FALSE),
               (5,1,18,TRUE ),(6,1,73,FALSE),(7,1,12,FALSE),(8,1,74,TRUE ),
               (7,2,12,FALSE),(6,2,73,FALSE)) AS v(pid, sid, jersey, cap)
 WHERE pt.player_id = v.pid AND pt.season_id = v.sid;

-- ---- sponsors --------------------------------------------------------
INSERT INTO sponsor (sponsor_id, company_name) VALUES
 (1, 'Tata Group'),
 (2, 'Dream11');

INSERT INTO sponsor_industry (sponsor_id, industry) VALUES
 (1, 'Conglomerate'),
 (2, 'Fantasy Sports'),
 (2, 'Gaming');

INSERT INTO season_sponsor (season_id, sponsor_id, sponsorship_type, contract_value, start_date, end_date) VALUES
 (1, 1, 'Title',     5000000000, '2023-01-01', '2023-12-31'),
 (1, 2, 'Associate', 1000000000, '2023-01-01', '2023-12-31'),
 (2, 1, 'Title',     5000000000, '2024-01-01', '2024-12-31'),
 (2, 2, 'Associate', 1200000000, '2024-01-01', '2024-12-31');

-- ---- umpires ---------------------------------------------------------
INSERT INTO umpire (umpire_id, umpire_name, nationality, experience_years) VALUES
 (1, 'Nitin Menon',         'India',       10),
 (2, 'Kumar Dharmasena',    'Sri Lanka',   20),
 (3, 'Chris Gaffaney',      'New Zealand', 12),
 (4, 'Richard Kettleborough','England',    15);

-- ---- matches (3 per season, umpires assigned in the same step) -------
-- schedule_match(season, stadium, date, time, type, team1, team2, {on-field umpires}, third umpire, fee)
-- 2023
SELECT schedule_match(1, 1, '2023-03-31', '19:30', 'League', 1, 2, ARRAY[1,2]);
SELECT schedule_match(1, 3, '2023-04-02', '19:30', 'League', 3, 4, ARRAY[3,4]);
SELECT schedule_match(1, 4, '2023-05-29', '19:30', 'Final',  1, 3, ARRAY[1,2], 3, 200000);
-- 2024
SELECT schedule_match(2, 2, '2024-03-23', '19:30', 'League', 2, 4, ARRAY[2,3]);
SELECT schedule_match(2, 1, '2024-03-24', '19:30', 'League', 1, 3, ARRAY[1,4]);
SELECT schedule_match(2, 4, '2024-05-26', '19:30', 'Final',  4, 1, ARRAY[2,3], 4, 200000);

-- ---- results ---------------------------------------------------------
-- record_result(match, toss winner, winner, result text)
CALL record_result(1, 2, 1, 'CSK won by 5 wickets');
CALL record_result(2, 3, 3, 'RCB won by 24 runs');
CALL record_result(3, 1, 1, 'CSK won by 6 runs');
CALL record_result(4, 4, 4, 'KKR won by 8 wickets');
CALL record_result(5, 3, 1, 'CSK won by 4 wickets');
CALL record_result(6, 1, 4, 'KKR won by 7 wickets');

-- ---- performances (3 per match) --------------------------------------
-- (match, player, runs, balls, wickets, overs, runs_conceded, catches)
INSERT INTO match_performance (match_id, player_id, runs, balls, wickets, overs, runs_conceded, catches) VALUES
 (1, 1, 45, 30, 0, 0.0,  0, 1),   -- Dhoni
 (1, 3, 30, 22, 0, 0.0,  0, 0),   -- Rohit
 (1, 2, 12,  8, 2, 4.0, 28, 0),   -- Jadeja
 (2, 5, 62, 41, 0, 0.0,  0, 0),   -- Kohli
 (2, 7, 28, 15, 1, 3.0, 30, 1),   -- Russell
 (2, 8, 15, 10, 2, 4.0, 24, 0),   -- Narine
 (3, 1, 38, 25, 0, 0.0,  0, 2),   -- Dhoni
 (3, 5, 54, 38, 0, 0.0,  0, 0),   -- Kohli
 (3, 6,  0,  0, 2, 4.0, 36, 0),   -- Siraj
 (4, 3, 40, 28, 0, 0.0,  0, 0),   -- Rohit
 (4, 4,  0,  0, 3, 4.0, 22, 0),   -- Bumrah
 (4, 8, 35, 18, 1, 4.0, 27, 0),   -- Narine
 (5, 1, 30, 18, 0, 0.0,  0, 1),   -- Dhoni
 (5, 5, 48, 35, 0, 0.0,  0, 0),   -- Kohli
 (5, 7, 20, 10, 2, 4.0, 31, 1),   -- Russell
 (6, 8, 25, 14, 1, 4.0, 26, 0),   -- Narine
 (6, 6,  0,  0, 3, 3.4, 20, 0),   -- Siraj
 (6, 2, 18, 15, 1, 4.0, 30, 1);   -- Jadeja

-- man of the match (must have a performance row, so it is set after)
UPDATE matches SET man_of_match_id = 1 WHERE match_id = 1;   -- Dhoni
UPDATE matches SET man_of_match_id = 5 WHERE match_id = 2;   -- Kohli
UPDATE matches SET man_of_match_id = 1 WHERE match_id = 3;   -- Dhoni
UPDATE matches SET man_of_match_id = 8 WHERE match_id = 4;   -- Narine
UPDATE matches SET man_of_match_id = 1 WHERE match_id = 5;   -- Dhoni
UPDATE matches SET man_of_match_id = 6 WHERE match_id = 6;   -- Siraj

-- ---- keep the identity counters in step with the explicit ids --------
SELECT setval(pg_get_serial_sequence('season',  'season_id'),  (SELECT MAX(season_id)  FROM season));
SELECT setval(pg_get_serial_sequence('team',    'team_id'),    (SELECT MAX(team_id)    FROM team));
SELECT setval(pg_get_serial_sequence('stadium', 'stadium_id'), (SELECT MAX(stadium_id) FROM stadium));
SELECT setval(pg_get_serial_sequence('player',  'player_id'),  (SELECT MAX(player_id)  FROM player));
SELECT setval(pg_get_serial_sequence('auction', 'auction_id'), (SELECT MAX(auction_id) FROM auction));
SELECT setval(pg_get_serial_sequence('sponsor', 'sponsor_id'), (SELECT MAX(sponsor_id) FROM sponsor));
SELECT setval(pg_get_serial_sequence('umpire',  'umpire_id'),  (SELECT MAX(umpire_id)  FROM umpire));

COMMIT;
