FROM localhost:15000/teamaibox/platform-api@sha256:41dade4de8d794b11e0964f99df0839ac0083998ceb8390c8409471df5fc68ea
COPY protected-office-generation-recovery.mjs protected-office-set-production-runtime-factory.mjs /opt/teamaibox/apps/platform-api/server/
