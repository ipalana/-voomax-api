-- voomax-api/supabase/schema.sql
-- Cole isso no SQL Editor do Supabase (Dashboard → SQL Editor → New Query)

-- ─── Extensões ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Alertas de preço ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_alerts (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       text,                          -- Supabase Auth UID (opcional na v1)
  origin        char(3)  NOT NULL,
  destination   char(3)  NOT NULL,
  target_price  integer,
  last_price    integer,
  notified_at   timestamptz,
  active        boolean DEFAULT true,
  created_at    timestamptz DEFAULT now()
);

-- ─── Histórico de preços ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  origin        char(3)  NOT NULL,
  destination   char(3)  NOT NULL,
  price         integer  NOT NULL,
  source        text,                          -- 'amadeus' | 'seats.aero'
  captured_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_route
  ON price_history (origin, destination, captured_at DESC);

-- ─── Cache de buscas ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_cache (
  cache_key     text PRIMARY KEY,
  payload       jsonb NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz DEFAULT now()
);

-- Limpa cache expirado automaticamente (roda diário via cron do Supabase)
CREATE OR REPLACE FUNCTION clean_expired_cache()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM search_cache WHERE expires_at < now();
$$;

-- ─── Row Level Security (RLS) ────────────────────────────────
-- Habilita RLS mas permite acesso via service key (backend)
ALTER TABLE price_alerts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_cache   ENABLE ROW LEVEL SECURITY;

-- Políticas: service role bypassa tudo, anon não acessa
CREATE POLICY "Service role full access - alerts"
  ON price_alerts FOR ALL TO service_role USING (true);

CREATE POLICY "Service role full access - history"
  ON price_history FOR ALL TO service_role USING (true);

CREATE POLICY "Service role full access - cache"
  ON search_cache FOR ALL TO service_role USING (true);
