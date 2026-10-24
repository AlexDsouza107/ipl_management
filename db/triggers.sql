-- =====================================================================
--  IPL MANAGEMENT SYSTEM  -  triggers.sql   (PostgreSQL 14+)
--  Run AFTER schema.sql.
--
--  Business rules that plain constraints cannot express:
--    T1  A team cannot spend more than its purse            (player_team)
--    T2  Selling a player at auction creates the signing    (auction_player)
--    T3  Match date must fall inside its season; man of the
--        match must have a performance row                  (matches)
--    T4  Performances only for started matches, and only by
--        players of the two teams playing                   (match_performance)
--    T5  Every match must have at least 2 on-field umpires  (deferred)
--    T6  An umpire cannot officiate two matches on one day  (match_umpire)
--
--  Plus stored routines the backend calls:
--    schedule_match(), record_result(), sell_player(), mark_unsold()
-- =====================================================================

-- ---------------------------------------------------------------------
-- T1  PURSE CHECK
--     Locks the team_season row so two simultaneous sales cannot both
--     squeeze under the limit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_check_purse() RETURNS trigger AS $$
DECLARE
    v_total NUMERIC;
    v_spent NUMERIC;
    v_name  TEXT;
BEGIN
    SELECT purse_total INTO v_total
      FROM team_season
     WHERE team_id = NEW.team_id AND season_id = NEW.season_id
       FOR UPDATE;

    -- team not registered for the season: let the foreign key report it
    IF v_total IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(SUM(price), 0) INTO v_spent
      FROM player_team
     WHERE team_id = NEW.team_id AND season_id = NEW.season_id
       AND player_id <> NEW.player_id;

    IF v_spent + NEW.price > v_total THEN
        SELECT team_name INTO v_name FROM team WHERE team_id = NEW.team_id;
        RAISE EXCEPTION 'Purse exceeded: % has only Rs % Cr left but the player costs Rs % Cr',
              v_name, ROUND((v_total - v_spent) / 10000000.0, 2), ROUND(NEW.price / 10000000.0, 2)
              USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER player_team_purse_check
    BEFORE INSERT OR UPDATE ON player_team
    FOR EACH ROW EXECUTE FUNCTION trg_check_purse();

-- ---------------------------------------------------------------------
-- T2  AUCTION SALE  ->  SIGNING
--     When auction_player becomes 'Sold', insert the player_team row
--     (price = sold_price).  If the sale is undone / changed / deleted,
--     the old signing is removed.  The purse trigger (T1) and the
--     (player_id, season_id) primary key then do the real validation.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_auction_sale() RETURNS trigger AS $$
DECLARE
    v_season INT;
BEGIN
    -- remove the previous signing if the row was Sold before
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'Sold' THEN
        SELECT season_id INTO v_season FROM auction WHERE auction_id = OLD.auction_id;
        DELETE FROM player_team
         WHERE player_id = OLD.player_id
           AND season_id = v_season
           AND team_id   = OLD.team_id;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status = 'Sold' THEN
        SELECT season_id INTO v_season FROM auction WHERE auction_id = NEW.auction_id;
        BEGIN
            INSERT INTO player_team (player_id, season_id, team_id, price)
            VALUES (NEW.player_id, v_season, NEW.team_id, NEW.sold_price);
        EXCEPTION WHEN unique_violation THEN
            RAISE EXCEPTION 'Player % is already signed by a team in this season',
                  NEW.player_id USING ERRCODE = 'unique_violation';
        END;
    END IF;

    RETURN NULL;   -- AFTER trigger, return value ignored
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auction_player_sale
    AFTER INSERT OR UPDATE OR DELETE ON auction_player
    FOR EACH ROW EXECUTE FUNCTION trg_auction_sale();

-- ---------------------------------------------------------------------
-- T3  MATCH VALIDATION
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_match_validate() RETURNS trigger AS $$
DECLARE
    v_start DATE;
    v_end   DATE;
BEGIN
    SELECT start_date, end_date INTO v_start, v_end
      FROM season WHERE season_id = NEW.season_id;

    IF NEW.match_date < v_start OR NEW.match_date > v_end THEN
        RAISE EXCEPTION 'Match date % is outside the season (% to %)',
              NEW.match_date, v_start, v_end
              USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.man_of_match_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM match_performance
         WHERE match_id = NEW.match_id AND player_id = NEW.man_of_match_id) THEN
        RAISE EXCEPTION 'Man of the match must have a performance record in this match'
              USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER matches_validate
    BEFORE INSERT OR UPDATE ON matches
    FOR EACH ROW EXECUTE FUNCTION trg_match_validate();

-- ---------------------------------------------------------------------
-- T4  PERFORMANCE VALIDATION
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_performance_validate() RETURNS trigger AS $$
DECLARE
    v_match  matches%ROWTYPE;
    v_team   INT;
BEGIN
    SELECT * INTO v_match FROM matches WHERE match_id = NEW.match_id;

    IF v_match.status = 'Scheduled' THEN
        RAISE EXCEPTION 'Match % has not been played yet', NEW.match_id
              USING ERRCODE = 'check_violation';
    END IF;

    SELECT team_id INTO v_team
      FROM player_team
     WHERE player_id = NEW.player_id AND season_id = v_match.season_id;

    IF v_team IS NULL OR v_team NOT IN (v_match.team1_id, v_match.team2_id) THEN
        RAISE EXCEPTION 'Player % does not belong to either team playing match %',
              NEW.player_id, NEW.match_id
              USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER performance_validate
    BEFORE INSERT OR UPDATE ON match_performance
    FOR EACH ROW EXECUTE FUNCTION trg_performance_validate();

-- ---------------------------------------------------------------------
-- T5  EVERY MATCH NEEDS >= 2 ON-FIELD UMPIRES
--     A DEFERRED constraint trigger: it is checked at COMMIT, so the
--     match and its umpires can be inserted in one transaction (this is
--     exactly what schedule_match() does).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_match_needs_umpires() RETURNS trigger AS $$
DECLARE
    v_ids INT[];
    v_id  INT;
    v_cnt INT;
BEGIN
    IF TG_TABLE_NAME = 'matches' OR TG_OP = 'INSERT' THEN
        v_ids := ARRAY[NEW.match_id];
    ELSIF TG_OP = 'DELETE' THEN
        v_ids := ARRAY[OLD.match_id];
    ELSE
        v_ids := ARRAY[OLD.match_id, NEW.match_id];
    END IF;

    FOREACH v_id IN ARRAY v_ids LOOP
        -- match may have been deleted (cascade): nothing to check
        IF EXISTS (SELECT 1 FROM matches WHERE match_id = v_id) THEN
            SELECT COUNT(*) INTO v_cnt
              FROM match_umpire
             WHERE match_id = v_id AND role = 'On-field';
            IF v_cnt < 2 THEN
                RAISE EXCEPTION 'Match % needs at least 2 on-field umpires (has %)',
                      v_id, v_cnt USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER match_has_umpires
    AFTER INSERT ON matches
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_match_needs_umpires();

CREATE CONSTRAINT TRIGGER umpire_rows_keep_minimum
    AFTER INSERT OR UPDATE OR DELETE ON match_umpire
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_match_needs_umpires();

-- ---------------------------------------------------------------------
-- T6  UMPIRE CANNOT BE IN TWO PLACES ON THE SAME DAY
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_umpire_no_clash() RETURNS trigger AS $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM match_umpire mu
          JOIN matches other ON other.match_id = mu.match_id
          JOIN matches this  ON this.match_id  = NEW.match_id
         WHERE mu.umpire_id = NEW.umpire_id
           AND mu.match_id <> NEW.match_id
           AND other.match_date = this.match_date) THEN
        RAISE EXCEPTION 'Umpire % is already assigned to another match on that date',
              NEW.umpire_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER umpire_clash_check
    BEFORE INSERT OR UPDATE ON match_umpire
    FOR EACH ROW EXECUTE FUNCTION trg_umpire_no_clash();


-- =====================================================================
--  STORED ROUTINES  (called by the backend)
-- =====================================================================

-- Schedule a match and assign its umpires in ONE transaction.
-- Returns the new match_id.  Fails (and rolls back everything) if fewer
-- than two on-field umpires are given.
CREATE OR REPLACE FUNCTION schedule_match(
    p_season      INT,
    p_stadium     INT,
    p_date        DATE,
    p_time        TIME,
    p_type        VARCHAR,
    p_team1       INT,
    p_team2       INT,
    p_umpires     INT[],             -- on-field umpires
    p_third       INT     DEFAULT NULL,
    p_fee         NUMERIC DEFAULT 150000
) RETURNS INT AS $$
DECLARE
    v_match INT;
    v_ump   INT;
BEGIN
    INSERT INTO matches (season_id, stadium_id, match_date, match_time,
                         match_type, team1_id, team2_id)
    VALUES (p_season, p_stadium, p_date, p_time, p_type, p_team1, p_team2)
    RETURNING match_id INTO v_match;

    FOREACH v_ump IN ARRAY p_umpires LOOP
        INSERT INTO match_umpire (match_id, umpire_id, role, fee)
        VALUES (v_match, v_ump, 'On-field', p_fee);
    END LOOP;

    IF p_third IS NOT NULL THEN
        INSERT INTO match_umpire (match_id, umpire_id, role, fee)
        VALUES (v_match, p_third, 'Third', p_fee);
    END IF;

    RETURN v_match;
END;
$$ LANGUAGE plpgsql;

-- Record the result of a match.  p_winner NULL => 'No Result'.
CREATE OR REPLACE PROCEDURE record_result(
    p_match   INT,
    p_toss    INT,
    p_winner  INT,
    p_text    VARCHAR,
    p_mom     INT DEFAULT NULL
) AS $$
BEGIN
    UPDATE matches
       SET toss_winner_id  = p_toss,
           winner_id       = p_winner,
           status          = CASE WHEN p_winner IS NULL THEN 'No Result'
                                  ELSE 'Completed' END,
           result_text     = p_text,
           man_of_match_id = p_mom
     WHERE match_id = p_match;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Match % does not exist', p_match;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Sell a player at auction.  Everything else (signing row, purse check,
-- one-team-per-season) happens in the triggers above; any failure
-- rolls the whole statement back.
CREATE OR REPLACE PROCEDURE sell_player(
    p_auction INT,
    p_player  INT,
    p_team    INT,
    p_price   NUMERIC
) AS $$
DECLARE
    v_status VARCHAR;
BEGIN
    SELECT status INTO v_status
      FROM auction_player
     WHERE auction_id = p_auction AND player_id = p_player
       FOR UPDATE;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Player % is not in the pool of auction %',
              p_player, p_auction;
    ELSIF v_status = 'Sold' THEN
        RAISE EXCEPTION 'Player % is already sold in auction %: player is already signed by a team in this season',
              p_player, p_auction USING ERRCODE = 'unique_violation';
    END IF;

    UPDATE auction_player
       SET status = 'Sold', sold_price = p_price, team_id = p_team
     WHERE auction_id = p_auction AND player_id = p_player;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE PROCEDURE mark_unsold(p_auction INT, p_player INT) AS $$
BEGIN
    UPDATE auction_player
       SET status = 'Unsold', sold_price = NULL, team_id = NULL
     WHERE auction_id = p_auction AND player_id = p_player;
END;
$$ LANGUAGE plpgsql;
