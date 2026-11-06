-- PLAN 6.5, plus the small tables the plan's prose implies: aggregates (F14 sliding windows),
-- activity (F4 presence), agent_messages (F6 mismatch), timers (F5), route_traces (F13), meta.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  vendor TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  class TEXT,
  tier TEXT,
  score REAL,
  call_hash TEXT,
  decision TEXT NOT NULL,
  step TEXT NOT NULL,
  request_id TEXT,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS actions_agent_class ON actions (agent, class, at);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  source TEXT NOT NULL,
  vendor TEXT NOT NULL,
  agent TEXT NOT NULL,
  call_hash TEXT NOT NULL,
  class TEXT NOT NULL,
  target TEXT NOT NULL,
  call TEXT NOT NULL,
  tier TEXT NOT NULL,
  score REAL NOT NULL,
  state TEXT NOT NULL,
  requester_ids TEXT NOT NULL,
  agent_owner_id TEXT,
  origin_room TEXT,
  origin_thread TEXT,
  evidence TEXT NOT NULL,
  flags TEXT NOT NULL,
  quorum_required INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  exec_attempts INTEGER NOT NULL DEFAULT 0,
  is_drill INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS requests_open ON requests (state, expires_at);
CREATE INDEX IF NOT EXISTS requests_hash ON requests (call_hash, agent, state);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  user_id TEXT,
  step TEXT NOT NULL,
  card_room TEXT NOT NULL,
  session_id TEXT NOT NULL,
  switch_request_id TEXT NOT NULL,
  handle TEXT,
  notified_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS routes_request ON routes (request_id);
CREATE INDEX IF NOT EXISTS routes_switch ON routes (switch_request_id);
CREATE INDEX IF NOT EXISTS routes_user ON routes (user_id, closed_at);

CREATE TABLE IF NOT EXISTS route_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  trace TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS route_traces_request ON route_traces (request_id);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  switch_request_id TEXT NOT NULL,
  answered_by TEXT,
  user_id TEXT,
  decision TEXT,
  latency_ms INTEGER,
  eligible INTEGER NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS answers_request ON answers (request_id);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  call_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_action TEXT
);
CREATE INDEX IF NOT EXISTS grants_hash ON grants (call_hash, agent);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  request_id TEXT,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_request ON ledger (request_id);

CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only');
END;

CREATE TABLE IF NOT EXISTS people (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mxids TEXT NOT NULL,
  groups TEXT NOT NULL,
  roles TEXT NOT NULL,
  rota TEXT,
  away_until INTEGER,
  delegate_to TEXT,
  last_active_at INTEGER
);

CREATE TABLE IF NOT EXISTS activity (
  user_id TEXT NOT NULL,
  room TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, room)
);

CREATE TABLE IF NOT EXISTS requesters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  room TEXT NOT NULL,
  thread TEXT,
  user_id TEXT NOT NULL,
  on_behalf_of TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requesters_agent ON requesters (agent, at);

CREATE TABLE IF NOT EXISTS room_voices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS room_voices_room ON room_voices (room, at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  room TEXT NOT NULL,
  thread TEXT,
  body TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_messages_agent ON agent_messages (agent, room, at);

CREATE TABLE IF NOT EXISTS aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class TEXT NOT NULL,
  by_field TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  agent TEXT NOT NULL,
  action_id TEXT NOT NULL,
  request_id TEXT,
  at INTEGER NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS aggregates_key ON aggregates (class, by_field, key, at);
CREATE INDEX IF NOT EXISTS aggregates_agent ON aggregates (agent, class, at);
CREATE INDEX IF NOT EXISTS aggregates_request ON aggregates (request_id);

CREATE TABLE IF NOT EXISTS autonomy (
  agent TEXT NOT NULL,
  class TEXT NOT NULL,
  bucket TEXT NOT NULL,
  level TEXT NOT NULL,
  since INTEGER NOT NULL,
  counters TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (agent, class, bucket)
);

CREATE TABLE IF NOT EXISTS bucket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  class TEXT NOT NULL,
  bucket TEXT,
  request_id TEXT,
  at INTEGER NOT NULL,
  fields TEXT NOT NULL,
  amount REAL,
  outcome TEXT NOT NULL,
  approvers TEXT NOT NULL,
  fast INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  incident INTEGER NOT NULL DEFAULT 0,
  auto_eligible INTEGER NOT NULL DEFAULT 0,
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bucket_events_class ON bucket_events (class, agent, at);
CREATE INDEX IF NOT EXISTS bucket_events_bucket ON bucket_events (agent, class, bucket, at);
CREATE INDEX IF NOT EXISTS bucket_events_request ON bucket_events (request_id);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  quorum INTEGER NOT NULL,
  exclude TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS proposals_subject ON proposals (subject, state);

CREATE TABLE IF NOT EXISTS proposal_votes (
  proposal_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  switch_request_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);

CREATE TABLE IF NOT EXISTS timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  fired_at INTEGER
);
CREATE INDEX IF NOT EXISTS timers_due ON timers (fired_at, fire_at);
CREATE INDEX IF NOT EXISTS timers_request ON timers (request_id);

CREATE TABLE IF NOT EXISTS drills (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  flaw_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  result TEXT,
  latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  note TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_versions (
  hash TEXT NOT NULL,
  loaded_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  approved_by TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (hash, loaded_at)
);
