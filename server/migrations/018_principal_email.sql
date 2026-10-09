-- The email address the sign-in issuer last reported for a human principal (ID token `email` claim, refreshed at each
-- sign-in). Only the principal's own session reads it; NULL until the next sign-in, and for agents and devices.
ALTER TABLE principals ADD COLUMN email VARCHAR(320) NULL;
