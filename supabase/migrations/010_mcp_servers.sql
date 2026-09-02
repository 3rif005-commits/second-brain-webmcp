-- MCP server registry (one row per user-configured external server)
CREATE TABLE mcp_servers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  transport   TEXT        NOT NULL CHECK (transport IN ('stdio', 'http', 'sse')),
  command     TEXT,                           -- stdio: full shell command
  url         TEXT,                           -- http/sse: base URL
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  trust_level TEXT        NOT NULL DEFAULT 'read_only'
              CHECK (trust_level IN ('read_only', 'full')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own mcp_servers"
  ON mcp_servers FOR ALL USING (auth.uid() = user_id);

-- Audit log: one row per MCP tool call made by the agent
CREATE TABLE mcp_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  server_name TEXT        NOT NULL,
  tool_name   TEXT        NOT NULL,
  args_json   JSONB,
  result_code TEXT        NOT NULL DEFAULT 'ok'
              CHECK (result_code IN ('ok', 'error', 'denied')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE mcp_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own audit log"
  ON mcp_audit_log FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "service inserts audit log"
  ON mcp_audit_log FOR INSERT WITH CHECK (true);

CREATE INDEX mcp_audit_log_user_idx ON mcp_audit_log (user_id, created_at DESC);
