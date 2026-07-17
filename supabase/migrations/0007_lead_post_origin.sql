alter table socialbot_leads
  add column if not exists post_id text,
  add column if not exists post_permalink text;
