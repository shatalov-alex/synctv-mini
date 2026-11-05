-- Mini App launches carry a last name; the room's viewer list shows it.
ALTER TABLE auth_telegram_identities ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);

-- Invited guests and TVs may no longer add videos (MANAGE_OWN_MEDIA, bit 1). They are the room
-- admins with exactly the old restriction mask; nothing else in the app sets it.
UPDATE room_members
SET admin_removed_permissions = admin_removed_permissions | 2
WHERE admin_removed_permissions = 259008;
