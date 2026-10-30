# Development deployment

Local, disposable dependency and service composition belongs here. It must
remain clearly distinct from appliance data and production-like persistence.

Create two temporary files readable only by the current user: a PostgreSQL
password and a NATS token. Then render or start the foundation with:

    export TEAMAIBOX_POSTGRES_PASSWORD_FILE=/absolute/path/postgres-password
    export TEAMAIBOX_NATS_TOKEN_FILE=/absolute/path/nats-token
    docker compose \
      --env-file deploy/compose/images.arm64.env \
      -f deploy/compose/core.yaml \
      -f deploy/development/compose.yaml \
      config

The development overlay exposes only loopback ports 18080 and 18081.
