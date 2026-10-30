# Initial administrator setup

## Local-owner boundary

Team AI Box uses local accounts only. There is no LDAP, Active Directory,
OIDC, enterprise SSO, MFA, directory synchronization, hidden emergency
administrator, or user-facing “My API Key” screen. The first-run transaction
creates exactly one owner and cannot run again after identity state exists.

The isolated authenticated preview loads `PLATFORM_API_BOOTSTRAP_FILE` and
recreates an in-memory development owner after restart. That behavior is for
integration testing only. The durable Platform API composition injects the
transactional PostgreSQL identity repository on the encrypted data root. It
serializes the one successful owner transaction and, on later restarts, detects
the durable bootstrap record before reading the one-time secret file. Appliance
packaging must still remove or invalidate that file after successful setup and
must not treat the memory-backed preview as release evidence.

## Create the first owner

Use the local release setup surface over the appliance's verified HTTPS origin.
Confirm the certificate fingerprint and appliance identity before entering a
password. If the appliance uses a private CA, complete
[browser trust onboarding](browser-trust-onboarding.md) through a separate
trusted administrator channel and fully restart the browser first. Choose a
unique login and display name. Passwords contain at least 15
Unicode code points and are checked against local/common/context blocklists;
they are protected with versioned Argon2id parameters.

The setup form also requires the high-entropy one-time appliance setup code
delivered separately by the installation workflow. The Platform API reads only
its protected file, keeps a SHA-256 digest in process memory, compares proofs in
constant time, and never logs or stores the code in browser state. If no setup
code authority is configured, remote owner creation fails closed; same-origin
HTTPS alone is not sufficient because another LAN client could otherwise claim
an uninitialized appliance first. Remove or invalidate the setup-code file after
the owner transaction commits.

The transaction returns eight one-time recovery codes exactly once. Save them
offline, separately from the appliance and browser password store. Confirm that the saved copy is readable, then leave the setup
surface and sign in normally. Never photograph or attach recovery codes to a
support bundle.

## First-session checklist

From the administrator panel:

1. Set locale (`zh-CN` or `en`) and theme (Light or Dark), then verify they
   persist after sign-out.
2. Open Device and verify this appliance's CPU, unified-memory, storage, queue, model, and service
   metrics are fresh; missing telemetry is a fault, not zero usage.
3. Create a separate normal local user and test that it sees applications but
   not resource scheduling, users, device, providers, sources, models,
   plugins, updates, or audit administration.
4. Review the source policy, external provider data policy, installed plugin
   permissions, model certification state, service health, and alert
   thresholds before enabling user compute.
5. Verify the installed appliance identity and local execution service. Model
   work, virtual phones, Windows and cameras must use this same appliance;
   external AI providers, if configured, are a separate optional API route.

Resource scheduling and destructive administration belong to authorized
administrators. Normal users invoke granted applications, view and cancel
their own tasks, use messaging/files, and cannot change global resource
policies.

## Recovery and account safety

Owner recovery resets the existing owner; it never creates a bypass identity.
It requires a recovery code and a separately controlled local-presence proof,
increments password version, revokes every session, and replaces all recovery
codes. Disabling the last active owner is rejected. After recovery, review the
audit chain, active accounts, service credentials, provider secrets, and service
health before reopening compute admission.
