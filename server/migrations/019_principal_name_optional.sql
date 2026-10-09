-- A human principal whose sign-in issuer reported no name has no display name; Settings then shows the email and shared
-- or audit text uses a neutral label. Agents and devices always carry one.
ALTER TABLE principals MODIFY COLUMN display_name VARCHAR(200) NULL;
