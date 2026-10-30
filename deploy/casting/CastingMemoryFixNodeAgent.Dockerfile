# Remote exact running parent; no new package, capability or runtime dependency.
FROM localhost:15000/teamaibox/node-agent:main-boot-recovery-20260907-a2
COPY --chmod=0555 node-agent /usr/local/bin/teamaibox-node-agent
USER 10001:10001
LABEL org.teamaibox.casting="authenticated-inactive-file-metrics"
