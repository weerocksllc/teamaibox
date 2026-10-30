# Plugin locale and theme SDK v1

`@teamaibox/plugin-sdk/preferences-v1` is the public presentation-preference
contract for ApplicationPlugins. It does not expose account credentials or
private Web-shell state.

The host resolves each manifest against the active locale, text direction, and
Light/Dark theme. The result contains requested and effective preferences,
four compatibility booleans, and ordered launch disclosures for locale,
direction, theme, or unavailable live updates. A third-party plugin therefore
cannot silently choose a fallback. The same resolver can be used by the
pre-install compatibility view and by the launch dialog while platform-owned
navigation and messages remain in the user's active language.

Official plugins fail closed unless they declare Simplified Chinese and
English, Light and Dark, semantic tokens, and live preference events. The Web
catalog applies this declaration to every official application and publishes a
revisioned snapshot after every platform preference change. Official surfaces
also consume the same CSS variables, so the update does not require a reload or
separate plugin setting/sign-in.

Each snapshot carries the effective locale, direction, theme, and exactly the
v1 semantic token set. The SDK rejects missing, extra, empty, stale,
cross-plugin, or internally inconsistent snapshots. Same-process plugins can
use the revisioned channel. Iframe plugins receive the same message through an
exact HTTP(S) target origin and accept it only from the configured host window
and origin; wildcard origins are forbidden.

The current semantic contract covers canvas/surfaces, text, borders,
interactions, focus/disabled states, status colors, charts, code/log surfaces,
and shadows. It contains no app-specific raw color names.

## Bounded application presentation startup

The host installs its presentation listener in a layout effect and reconciles
the official iframe's `data-ui-presented-locale` marker with the effective
locale. A marker is accepted only from the expected same-origin application
path; an initial `about:blank` document or a different language cannot reveal
the frame. This also covers a ready message missed during mounting.

Startup observation is bounded to 32 checks at 250 ms intervals. If the
document does not become ready, the host displays a startup error and an
explicit Retry action instead of leaving an indefinite loading indicator.
A later valid load/ready event may still recover the presentation. There is
no automatic iframe reload, application restart, or business API probe.
Preference reconciliation does not replay application handoff commands.
Unmounting or changing preferences cancels the previous observer.
