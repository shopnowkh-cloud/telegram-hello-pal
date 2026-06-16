CREATE TABLE public.bot_kv (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.bot_kv TO service_role;

ALTER TABLE public.bot_kv ENABLE ROW LEVEL SECURITY;

-- No client roles get access; only service_role (used by the webhook handler) can touch it.
CREATE POLICY "service_role only"
  ON public.bot_kv
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

INSERT INTO public.bot_kv (key, value) VALUES
  ('accounts',  '{"account_types":{},"prices":{}}'::jsonb),
  ('sessions',  '{}'::jsonb),
  ('settings',  '{}'::jsonb),
  ('users',     '{}'::jsonb),
  ('purchases', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;
