#!/bin/bash
# Runs after the upstream script creates the private CATALINA_BASE.
# The browser always enters through authenticated Platform HTTPS, never Tomcat.
test -n "$CATALINA_BASE"
test "$(grep -c '<Connector port="8080"' "$CATALINA_BASE/conf/server.xml")" = 1
sed -i \
  -e 's/<Connector port="8080"/<Connector address="127.0.0.1" port="18088"/' \
  -e '/<Valve className="org.apache.catalina.valves.AccessLogValve"/,/\/>/d' \
  "$CATALINA_BASE/conf/server.xml"
# Connection credentials must never enter an HTTP access log.
! grep -q 'AccessLogValve' "$CATALINA_BASE/conf/server.xml"
grep -q '<Connector address="127.0.0.1" port="18088"' "$CATALINA_BASE/conf/server.xml"
