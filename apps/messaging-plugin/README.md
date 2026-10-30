# Messaging ApplicationPlugin

The official Messaging browser application is a non-root, read-only static
container. It uses only delegated `platform.messaging` and `platform.objects`
APIs through the appliance same-origin Web boundary. It has no direct database,
object-store, Docker socket, host mount, device, or external-network access.

The desktop UI provides conversation, message, and participant panes. At mobile
browser widths it switches between a conversation list and a full-screen chat;
there is deliberately no native mobile application dependency.

Attachments are uploaded into the protected object service and submitted to
messaging as short-lived reference IDs. Durable messages receive immutable
object/version facts from the server and never retain the upload reference.
Realtime events carry a durable sequence cursor and reconnect through replay.

Run `node --test apps/messaging-plugin/test/*.test.mjs` from the repository root.
