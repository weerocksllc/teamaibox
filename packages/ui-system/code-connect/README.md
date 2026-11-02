# Figma Code Connect

This isolated, developer-only package contains a template to connect the existing React `Button` to
Figma component `4:8` (`TAB / Button`). It is outside the workspace package globs
and is not a product build or installation dependency. Its files are never
imported by the web application or a plugin.

## Publication status

The template is prepared and locally checked. The Figma MCP refused the save
because Code Connect requires the component library to be on an Organization or
Enterprise plan. Reading the mapping back still returned no React connection.
Do not describe the remote connection as published. No plan change or payment
was made. This limitation does not affect the design file or application UI;
implementation can continue using the existing components without Code Connect.

## Check locally

From this directory, run `npm ci --ignore-scripts`, then `npm run check`.
The checks cover all 15 style/state combinations, dynamic labels, the component
import and the existing busy/disabled behavior. They do not connect to a box.

`Button.figma.ts` is a parserless template (`figma.code`), not a `.figma.tsx`
`figma.connect()` definition. `figma.config.json` discovers only these templates;
`tsconfig.json` loads the official template types separately from product types.

## Property correspondence

| Figma property | Existing React API |
| --- | --- |
| Label | `children` |
| Style: Primary / Secondary / Danger | `variant="primary" / "secondary" / "danger"` |
| State: Disabled | `disabled` |
| State: Busy | `busy` (the component already disables the button) |
| State: Default / Hover / Focus | Normal Button; interaction styling comes from CSS |

All Figma variant values are covered. No new props or product behavior are
introduced. The current Figma button has no configurable icon or child instance.

The connected Figma MCP manages publishing using its existing account connection.
Do not put access tokens, cookies or credentials in these files. When publishing
the template, preserve its `isParserless: true`, React import and
`nestable: true` metadata, and read the stored mapping back afterward.

The composed sidebar, navigation and illustrative result cards are intentionally
unmapped: they do not currently have matching standalone React component APIs.
Do not connect them to the whole `App`, invent APIs, or refactor product code just
to make a mapping appear complete.
