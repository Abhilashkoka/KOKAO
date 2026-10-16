-- Quick Create starters managed from Admin. Safe to run more than once.
CREATE TABLE IF NOT EXISTS quick_create_presets (
  id serial PRIMARY KEY,
  label text NOT NULL,
  vertical text NOT NULL,
  prompt text NOT NULL,
  duration_sec integer NOT NULL DEFAULT 10,
  aspect text NOT NULL DEFAULT '9:16',
  photo_hint text,
  music_prompt text,
  published boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quick_create_presets_published_idx
  ON quick_create_presets (published, vertical);
