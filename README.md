# IPL Management System (DBMS mini project)

Node.js + Express + **raw SQL** on PostgreSQL, with a plain HTML/JS frontend (no build step, no ORM).
Every screen has a **Show SQL** panel at the bottom that displays the exact query that just ran,
so you can point at the SQL during the viva.

## 1. Requirements
- Node.js 18 or newer
- PostgreSQL 14 or newer (a running server and the `postgres` user's password)

## 2. Setup
```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# open .env and put your PostgreSQL password in DATABASE_URL
npm run db:setup            # creates the database and runs the 4 SQL files
npm start                   # then open http://localhost:3000
```
`npm run db:setup` is safe to run again: it drops and recreates the tables with the sample data.
You can also run the SQL by hand: `schema.sql`, `triggers.sql`, `views.sql`, `seed.sql` (in `db/`, in that order).

## 3. The SQL files (`db/`)
| File | Contents |
|---|---|
| `schema.sql` | 17 tables, keys, CHECK / UNIQUE constraints, generated columns, indexes |
| `triggers.sql` | Triggers, a deferred constraint trigger, and stored routines |
| `views.sql` | Points table, purse, squad, player age, player stats, match details |
| `seed.sql` | 4 teams, 2 seasons, 8 players, 6 matches (prices/scores are made up) |

## 4. Where each SQL concept is shown
| Concept | Where to demo it |
|---|---|
| Primary / foreign / composite keys | `player_team (player_id, season_id)`, `match_performance (match_id, player_id)` |
| Weak entity | `match_performance` (Matches page, scorecard) |
| Multivalued attributes | `player_role`, `sponsor_industry` (Players page, Sponsors page) |
| Recursive relationship | `mentor` (a player's profile page) |
| CHECK / UNIQUE / partial unique index | try the invalid inputs: same team twice, 2 title sponsors, duplicate jersey |
| Generated columns | strike rate and economy in the scorecard |
| Views | Dashboard points table (`v_points_table`), purse cards (`v_team_purse`) |
| Trigger: purse limit | Auctions: sell a player for more than the team's purse |
| Trigger: sale creates signing | Auctions: sell a player, then look at that team's squad |
| One team per player per season | Auctions: sell a player who is already signed |
| Deferred constraint: 2 umpires per match | Matches: schedule a match with only one umpire |
| Stored function / procedure | `schedule_match()`, `record_result()`, `sell_player()`, `mark_unsold()` |
| Transactions | Add player (`BEGIN ... COMMIT`, visible in the SQL panel); duplicate player shows `ROLLBACK` |
| Joins, GROUP BY, HAVING | Dashboard, Stadiums, Umpires, Reports |
| Subqueries, EXISTS / NOT EXISTS, CTE, window functions, ROLLUP | Reports page (each card names its concept) |
| Read-only SQL | SQL Console runs only a single SELECT inside a READ ONLY transaction |

## 5. Project layout
```
server.js            API routes (all raw SQL; each response includes the SQL it ran)
scripts/setup-db.js  creates the DB and loads db/*.sql
public/              index.html, style.css, app.js (the whole UI)
db/                  schema.sql, triggers.sql, views.sql, seed.sql
```

## 6. Troubleshooting
- **"password authentication failed"**: fix the password in `.env`.
- **"Cannot connect to PostgreSQL"**: make sure the server is running and the port in `DATABASE_URL` is right (default 5432).
- **Port 3000 in use**: set `PORT=3001` in `.env`.
