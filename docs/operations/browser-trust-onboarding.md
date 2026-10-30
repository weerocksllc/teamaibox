# Browser trust onboarding

Team AI Box supports either an already browser-trusted public certificate or a
private appliance CA distributed by an administrator. A private CA handoff is a
security ceremony, not a warning-click workflow: users must compare the CA
SHA-256 fingerprint through a separate trusted administrator channel before
installing it.

Build the public-only handoff ZIP from an exact CA certificate:

```sh
python3 tools/build_browser_trust_bundle.py \
  --ca /protected/export/teamaibox-appliance-ca.crt \
  --origin https://teamaibox.example.lan \
  --label "Team AI Box" \
  --output /protected/export/teamaibox-browser-trust.zip
```

The deterministic ZIP contains only `teamaibox-appliance-ca.crt`, a digest-bound
manifest, and bilingual instructions. The builder rejects HTTP origins, leaf
certificates, multiple certificates, private keys, invalid/near-expiry CAs, and
unsafe labels. It never changes a workstation trust store.

The administrator distributes the ZIP through an authenticated out-of-band
channel, publishes the fingerprint separately, installs the CA using the target
operating system's administrator controls, and fully restarts the browser. The
user then opens the exact manifest origin and must see no certificate warning
before entering credentials. CA replacement and appliance retirement include
removal of the old trust anchor.

Creating or downloading a bundle is not release evidence. Task 15.11 still
requires current administrator and ordinary-user journeys in a real supported
browser after the certificate is trusted. A warning bypass, development CA,
`--ignore-certificate-errors`, custom HTTP client trust, or command-line TLS
probe does not qualify.

Release evidence is recorded only through the separate
`browser.appliance-authenticated-https.v1` contract described in the browser
regression runbook. The release-candidate gate revalidates that report and
derives its appliance claims from it instead of accepting manually asserted
booleans.
