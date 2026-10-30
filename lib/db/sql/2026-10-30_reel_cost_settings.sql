-- Showcase reel cost controls (Admin → Quick Create). Additive; safe to run more than once.
CREATE TABLE IF NOT EXISTS reel_cost_settings (
  id serial PRIMARY KEY,
  try_on_image_quality text NOT NULL DEFAULT 'medium',
  reel_resolution text NOT NULL DEFAULT '720p',
  default_bars integer NOT NULL DEFAULT 1,
  hero_mode_enabled boolean NOT NULL DEFAULT true,
  default_reel_style text NOT NULL DEFAULT 'hero',
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
