CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: remove old schedule if present
DO $$
BEGIN
  PERFORM cron.unschedule('telegram-payment-watchdog');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'telegram-payment-watchdog',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://project--bedf53fa-ffa1-4853-8be5-954f796b3fa1-dev.lovable.app/api/public/telegram/watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlbXh4Zmh3Ynh0aWthaHl2cmxzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzMwMDIsImV4cCI6MjA5NzIwOTAwMn0.UvHsymsFq6HTqUZcGFRzzi_FElWDVpqmNjwhPl8kfXo'
    ),
    body := '{}'::jsonb
  );
  $cron$
);
