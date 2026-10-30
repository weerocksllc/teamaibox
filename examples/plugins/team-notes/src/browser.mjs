import {
  applyPluginPreferenceSnapshotV1,
  createPluginPreferenceChannelV1,
  subscribePluginPreferenceMessagesV1,
} from "./preferences-v1.mjs";

const PLUGIN_ID = "example.team-notes";
const channel = createPluginPreferenceChannelV1();
const requested = document.querySelector("#requested-locale");
const effective = document.querySelector("#effective-locale");
const theme = document.querySelector("#effective-theme");
const revision = document.querySelector("#preference-revision");

channel.subscribe((snapshot) => {
  applyPluginPreferenceSnapshotV1({ currentDocument: document, snapshot });
  requested.textContent = snapshot.requested.locale;
  effective.textContent = snapshot.effective.locale;
  theme.textContent = snapshot.effective.theme;
  revision.textContent = String(snapshot.revision);
}, { emitCurrent: false });

const unsubscribe = subscribePluginPreferenceMessagesV1({
  currentWindow: window,
  hostWindow: parent,
  hostOrigin: location.origin,
  onChange(snapshot) {
    if (snapshot.pluginId === PLUGIN_ID) channel.publish(snapshot);
  },
});

window.addEventListener("pagehide", unsubscribe, { once: true });
parent.postMessage({ type: "teamaibox.plugin-ready/v1", pluginId: PLUGIN_ID }, location.origin);
