import { CastingApiError, normalizeCastingMediaConnectionV1 } from "./casting-client-v1.mjs";

const LIVEKIT_BROWSER_MODULE = "/plugins/official.wireless-casting/vendor/livekit-client-2.21.0.esm.mjs";

function unavailable(message, cause = undefined) {
  return new CastingApiError("cast_media_client_unavailable", message, 503, true, cause);
}

function validSdk(value) {
  return value && typeof value.Room === "function" && value.RoomEvent
    && value.Track?.Kind?.Video && value.Track?.Kind?.Audio;
}

export function createCastingMediaClientV1({
  loadSdk = () => import(LIVEKIT_BROWSER_MODULE),
  clock = () => new Date(),
  connectTimeoutMs = 20_000,
} = {}) {
  if (typeof loadSdk !== "function" || typeof clock !== "function"
    || !Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 20_000) {
    throw new TypeError("Casting media client dependencies are invalid");
  }
  let room = null;
  let connected = false;
  let video = null;
  let sdk = null;
  let attached = new Set();
  let intentionalDisconnect = false;
  let disconnectedCallback = null;
  let stateCallback = null;
  let playbackAttempt = 0;
  let playbackIssue = null;
  let removePlayingListener = null;
  let sourceSuspended = false;

  function state(value) { stateCallback?.(value); }
  function hasVideoTrack() {
    return room !== null && [...attached].some(track => track.kind === sdk?.Track.Kind.Video);
  }
  function mediaState() {
    state(sourceSuspended ? "source-stopped" : playbackIssue ?? (hasVideoTrack() ? "streaming" : "waiting-media"));
  }

  async function attemptPlayback(current) {
    if (room !== current || sourceSuspended) { mediaState(); return; }
    video.hidden = !hasVideoTrack();
    playbackIssue = null;
    const attempt = ++playbackAttempt;
    try {
      await video.play();
      if (room === current && attempt === playbackAttempt && !sourceSuspended) {
        playbackIssue = null;
        mediaState();
      }
    }
    catch (caught) {
      let error = caught;
      // Attaching the other media track can interrupt a pending play(). It
      // must not hide video or overwrite playback in a newer room/attempt.
      if (room !== current || attempt !== playbackAttempt || sourceSuspended || error?.name === "AbortError") return;
      // The explicit Start action may finish after browser gesture expiry.
      // Show the picture muted instead of requiring a second join. Sound
      // remains a visible, user-controlled action; no browser policy bypass.
      if (error?.name === "NotAllowedError" && !video.muted) {
        video.muted = true;
        try {
          await video.play();
          if (room === current && attempt === playbackAttempt && !sourceSuspended) {
            playbackIssue = null;
            mediaState();
          }
          return;
        } catch (mutedError) {
          if (room !== current || attempt !== playbackAttempt || sourceSuspended || mutedError?.name === "AbortError") return;
          error = mutedError;
        }
      }
      playbackIssue = error?.name === "NotAllowedError" ? "playback-gesture-required" : "playback-failed";
      mediaState();
    }
  }

  function clearTracks() {
    playbackAttempt += 1;
    playbackIssue = null;
    sourceSuspended = false;
    removePlayingListener?.();
    removePlayingListener = null;
    for (const track of attached) {
      try { track.detach?.(video); } catch { /* fail closed during teardown */ }
    }
    attached = new Set();
    if (video?.srcObject) video.srcObject = null;
    if (video) {
      video.pause?.();
      video.hidden = true;
    }
  }

  async function disconnect({ notify = false } = {}) {
    const current = room;
    room = null;
    connected = false;
    intentionalDisconnect = true;
    clearTracks();
    try { await current?.disconnect?.(true); } catch { /* credentials still die locally */ }
    intentionalDisconnect = false;
    state("disconnected");
    if (notify) disconnectedCallback?.();
  }

  async function connect({ connection, videoElement, onState = null, onDisconnected = null } = {}) {
    const normalized = normalizeCastingMediaConnectionV1(connection);
    if (!videoElement || typeof videoElement.play !== "function" || typeof videoElement.pause !== "function"
        || (onState !== null && typeof onState !== "function")
        || (onDisconnected !== null && typeof onDisconnected !== "function")) {
      throw new TypeError("Casting media playback dependencies are invalid");
    }
    if (new Date(normalized.expiresAt) <= clock()) {
      throw new CastingApiError("cast_media_connection_expired", "Casting media connection expired", 401, false);
    }
    await disconnect();
    video = videoElement;
    stateCallback = onState;
    disconnectedCallback = onDisconnected;
    video.muted = normalized.muted;
    video.playsInline = true;
    state("loading-client");
    try { sdk = await loadSdk(); } catch (error) {
      throw unavailable("The reviewed LiveKit browser client is not materialized", error);
    }
    if (!validSdk(sdk)) throw unavailable("The LiveKit browser client API is incompatible");
    // Vendor informational logs include memory-only signalling handles.
    sdk.setLogLevel?.(sdk.LogLevel?.silent ?? "silent");
    const current = new sdk.Room({
      adaptiveStream: true,
      dynacast: false,
      // The application owns pagehide disposal. The SDK's beforeunload hook
      // otherwise reports navigation as an unexpected disconnect and overwrites
      // the tab's viewing intent before the new document can resume it.
      disconnectOnPageLeave: false,
      reconnectPolicy: Object.freeze({ nextRetryDelayInMs: () => null }),
    });
    room = current;
    const playing = () => {
      if (room !== current || sourceSuspended) return;
      playbackIssue = null;
      mediaState();
    };
    video.addEventListener?.("playing", playing);
    removePlayingListener = () => video.removeEventListener?.("playing", playing);
    const subscribed = (track) => {
      if (room !== current || !track
          || (track.kind !== sdk.Track.Kind.Video && track.kind !== sdk.Track.Kind.Audio)) return;
      if (attached.has(track)) return;
      attached.add(track);
      if (sourceSuspended) { mediaState(); return; }
      track.attach(video);
      mediaState();
      void attemptPlayback(current);
    };
    const unsubscribed = (track) => {
      if (room !== current || !attached.delete(track)) return;
      try { track.detach?.(video); } catch { /* teardown remains bounded */ }
      video.hidden = !hasVideoTrack();
      if (attached.size === 0) { playbackAttempt += 1; playbackIssue = null; }
      mediaState();
    };
    current.on(sdk.RoomEvent.TrackSubscribed, subscribed);
    current.on(sdk.RoomEvent.TrackUnsubscribed, unsubscribed);
    current.on(sdk.RoomEvent.Reconnecting, () => { if (room === current) state("reconnect-required"); });
    current.on(sdk.RoomEvent.Reconnected, () => {
      // Automatic token reuse is not an accepted product path. The pinned
      // reconnect policy must prevent this event; fail closed if an SDK drifts.
      if (room === current) void disconnect({ notify: true });
    });
    current.on(sdk.RoomEvent.Disconnected, (reason) => {
      if (intentionalDisconnect || room !== current) return;
      room = null;
      connected = false;
      clearTracks();
      state("disconnected");
      const reasons = sdk.DisconnectReason;
      disconnectedCallback?.(reason !== undefined && reason === reasons?.PARTICIPANT_REMOVED ? "removed"
        : reason !== undefined && reason === reasons?.ROOM_DELETED ? "ended" : "connection_lost");
    });
    state("connecting");
    let deadline;
    try {
      await Promise.race([
        current.connect(normalized.url, normalized.accessToken,
          { autoSubscribe: true, maxRetries: 0, websocketTimeout: 10_000, peerConnectionTimeout: 10_000 }),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(Error("connection_deadline")), connectTimeoutMs); }),
      ]);
    } catch (error) {
      if (room === current) await disconnect();
      throw new CastingApiError("cast_media_connection_unavailable", "The encrypted viewing connection did not complete", 503, true);
    } finally { clearTimeout(deadline); }
    if (room !== current) throw unavailable("Casting media connection closed during startup");
    connected = true;
    // TrackSubscribed may precede connect() resolution.
    mediaState();
    return Object.freeze({ connected: true, sessionId: normalized.sessionId,
      viewerIdentityId: normalized.viewerIdentityId, grantId: normalized.grantId,
      expiresAt: normalized.expiresAt, initiallyMuted: normalized.muted });
  }

  function suspendSource() {
    if (!room) return false;
    sourceSuspended = true;
    playbackAttempt += 1;
    playbackIssue = null;
    for (const track of attached) {
      try { track.detach?.(video); } catch { /* sender stop must still clear the element */ }
    }
    if (video?.srcObject) video.srcObject = null;
    video?.pause?.();
    if (video) video.hidden = true;
    mediaState();
    return true;
  }

  function resumeSource() {
    const current = room;
    if (!current) return false;
    if (!sourceSuspended) { mediaState(); return true; }
    sourceSuspended = false;
    for (const track of attached) track.attach(video);
    mediaState();
    void attemptPlayback(current);
    return true;
  }

  return Object.freeze({ connect, disconnect, suspendSource, resumeSource,
    hasVideoTrack, isConnected: () => connected && room !== null });
}

export const castingMediaClientPolicyV1 = Object.freeze({
  sdk: "livekit-client",
  sdkVersion: "2.21.0",
  modulePath: LIVEKIT_BROWSER_MODULE,
  encryptedTransportOnly: true,
  autoReconnectAllowed: false,
  reconnectRequiresFreshExplicitJoin: true,
  maximumViewerEncodes: 0,
  credentialPersistence: "memory-only",
  recordingAllowed: false,
});
