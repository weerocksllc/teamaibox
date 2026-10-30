FROM teamaibox-catalog-health-boot-base:20260907-a1
COPY --chmod=0555 refresh-health.sh /opt/teamaibox/catalog-fixture/refresh-health.sh
