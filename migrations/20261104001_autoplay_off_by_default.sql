-- Autoplay is now opt-in: rooms created so far carry the old default of on, which nobody chose.
UPDATE room_settings
SET settings = jsonb_set(settings, '{autoPlay,enabled}', 'false')
WHERE settings #>> '{autoPlay,enabled}' = 'true';
