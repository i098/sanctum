# Security policy

This repository currently contains a design/implementation handoff and static documentation, not a production meeting service.
Security-sensitive implementation areas include microphone capture, recordings, team isolation, agent credentials, OAuth, and external actions.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository:
https://github.com/undeemed/sanctum/security/advisories/new

Do not disclose exploit details, credentials, private transcripts, or recordings in a public issue.
Include the affected revision, a minimal synthetic reproduction, expected access restrictions, and observed behavior.
If private reporting is unavailable, open a public issue asking for a private reporting channel without including sensitive details.

The documentation deployment never needs production database, recording, model, or integration credentials.
