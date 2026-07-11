-- Up Migration

-- Raw file registry: immutable, byte-for-byte archived CSVs are the source of
-- truth. Everything else in this schema is derived and regenerable.
CREATE TABLE raw_files (
  id BIGSERIAL PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'parsed', 'failed', 'quarantined', 'ignored')),
  error TEXT,
  g3x_metadata JSONB NOT NULL DEFAULT '{}'
);

-- One flight, assembled from 1..N log sessions (power cycles).
CREATE TABLE flights (
  id BIGSERIAL PRIMARY KEY,
  start_ts TIMESTAMPTZ NOT NULL,          -- first movement
  end_ts TIMESTAMPTZ NOT NULL,            -- last movement
  takeoff_ts TIMESTAMPTZ,
  landing_ts TIMESTAMPTZ,
  stitched BOOLEAN NOT NULL DEFAULT FALSE,
  origin_airport TEXT,
  dest_airport TEXT,
  landing_runway TEXT,
  parser_version INT NOT NULL,
  analyzer_version INT,
  ruleset_hash TEXT,
  status TEXT NOT NULL DEFAULT 'parsed'
    CHECK (status IN ('parsed', 'analyzed', 'analyze_failed')),
  summary JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX flights_start_ts_idx ON flights (start_ts DESC);

-- One per parsed raw file (= one G3X power cycle).
CREATE TABLE log_sessions (
  id BIGSERIAL PRIMARY KEY,
  raw_file_id BIGINT NOT NULL REFERENCES raw_files(id) ON DELETE CASCADE,
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  sample_count INT NOT NULL,
  first_move_ts TIMESTAMPTZ,              -- gs > threshold sustained
  last_move_ts TIMESTAMPTZ,
  first_airborne TIMESTAMPTZ,             -- stitch hints
  last_airborne TIMESTAMPTZ,
  start_lat DOUBLE PRECISION,
  start_lon DOUBLE PRECISION,
  end_lat DOUBLE PRECISION,
  end_lon DOUBLE PRECISION,
  parser_version INT NOT NULL,
  flight_id BIGINT REFERENCES flights(id) ON DELETE SET NULL
);

CREATE INDEX log_sessions_raw_file_idx ON log_sessions (raw_file_id);
CREATE INDEX log_sessions_flight_idx ON log_sessions (flight_id);
CREATE INDEX log_sessions_start_ts_idx ON log_sessions (start_ts);

-- Wide 1 Hz canonical samples (Stage A parse output only — no derived data).
-- Column set mirrors SAMPLE_PARAMS in @foqa/shared params.ts.
CREATE TABLE samples (
  flight_id BIGINT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  alt_msl_ft REAL,
  alt_gps_ft REAL,
  pitch_deg REAL,
  roll_deg REAL,
  hdg_deg REAL,
  track_deg REAL,
  ias_kt REAL,
  tas_kt REAL,
  gs_kt REAL,
  vsi_fpm REAL,
  norm_g REAL,
  lat_g REAL,
  rpm REAL,
  oil_temp_c REAL,
  oil_press_psi REAL,
  coolant_temp_c REAL,
  egt1_c REAL,
  egt2_c REAL,
  egt3_c REAL,
  egt4_c REAL,
  fuel_flow_gph REAL,
  fuel_qty_gal REAL,
  volts REAL,
  amps REAL,
  oat_c REAL,
  extra JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (flight_id, ts)
);

-- Stage B (analyze) derived channels; separately deletable/regenerable.
CREATE TABLE samples_derived (
  flight_id BIGINT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  agl_ft REAL,
  terrain_elev_ft REAL,
  dist_thr_nm REAL,
  gp_dev_deg REAL,
  egt_spread_c REAL,
  PRIMARY KEY (flight_id, ts)
);

CREATE TABLE flight_phases (
  id BIGSERIAL PRIMARY KEY,
  flight_id BIGINT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (
    'preflight', 'taxi', 'takeoff', 'climb', 'cruise', 'descent',
    'approach', 'landing', 'go_around', 'rollout', 'postflight'
  )),
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  UNIQUE (flight_id, seq)
);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  flight_id BIGINT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'caution', 'warning', 'exceedance')),
  phase TEXT,
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  duration_s REAL NOT NULL,
  peak_value REAL,
  peak_ts TIMESTAMPTZ,
  threshold JSONB NOT NULL DEFAULT '{}',
  details JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX events_flight_idx ON events (flight_id);
CREATE INDEX events_rule_idx ON events (rule_id, start_ts);

-- FAA NASR reference data (imported by `foqa import-nasr`).
CREATE TABLE airports (
  ident TEXT PRIMARY KEY,            -- e.g. KLOT
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  elev_ft REAL NOT NULL
);

CREATE TABLE runways (
  id BIGSERIAL PRIMARY KEY,
  airport_ident TEXT NOT NULL REFERENCES airports(ident) ON DELETE CASCADE,
  end_ident TEXT NOT NULL,           -- e.g. "27"
  thr_lat DOUBLE PRECISION NOT NULL,
  thr_lon DOUBLE PRECISION NOT NULL,
  elev_ft REAL NOT NULL,
  heading_deg_true REAL NOT NULL,
  length_ft REAL NOT NULL,
  width_ft REAL,
  UNIQUE (airport_ident, end_ident)
);

-- TimescaleDB is an optimization, not a requirement: in the Docker deployment
-- (timescale/timescaledb image) samples become hypertables; on vanilla
-- Postgres (dev/test) they stay plain tables with identical semantics.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'timescaledb unavailable (%); samples remain plain tables', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('samples', 'ts',
      chunk_time_interval => INTERVAL '30 days', migrate_data => TRUE);
    PERFORM create_hypertable('samples_derived', 'ts',
      chunk_time_interval => INTERVAL '30 days', migrate_data => TRUE);
  END IF;
END $$;

-- Down Migration

DROP TABLE IF EXISTS runways;
DROP TABLE IF EXISTS airports;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS flight_phases;
DROP TABLE IF EXISTS samples_derived;
DROP TABLE IF EXISTS samples;
DROP TABLE IF EXISTS log_sessions;
DROP TABLE IF EXISTS flights;
DROP TABLE IF EXISTS raw_files;
