<!-- doc-navigation:start -->
[English](SECURITY.md) · [简体中文](SECURITY.zh-CN.md) · [繁體中文](SECURITY.zh-TW.md) · [日本語](SECURITY.ja.md) · [한국어](SECURITY.ko.md) · [Français](SECURITY.fr.md) · [Deutsch](SECURITY.de.md) · [Español](SECURITY.es.md) · [Português](SECURITY.pt-BR.md) · [Русский](SECURITY.ru.md) · [العربية](SECURITY.ar.md) · [हिन्दी](SECURITY.hi.md) · [Bahasa Indonesia](SECURITY.id.md) · [Italiano](SECURITY.it.md) · [Türkçe](SECURITY.tr.md) · [Tiếng Việt](SECURITY.vi.md) · [ไทย](SECURITY.th.md)

[Team AI Box — README](README.md)
<!-- doc-navigation:end -->

# Security reports

Please report suspected vulnerabilities privately to **teamaibox@weerocks.llc**.
Include affected version, minimal reproduction, impact and redacted logs. Do
not put credentials, customer content or exploit details in public issues.
Ask for an appropriate secure transfer channel before sending sensitive files.
No response-time guarantee or independent security certification is claimed.

New offline installations currently use the documented bootstrap administrator
`admin` / `admin`; change that password before exposing the appliance to users
or an untrusted network. This is a public initial credential, not a secret to
hide in a scanner allowlist. No ordinary user account is created automatically.
Changing this onboarding behavior is outside this licensing change.

## Source/history review

See [the public source privacy boundary](docs/open-source/SOURCE-PRIVACY.md) for
excluded data, history review and credential-rotation responsibilities.

Run the pinned local scanner as described in [release preparation](docs/open-source/RELEASING.md).
Reports are private, redacted and never uploaded to an external scanning service.
If a real credential appears in private history, deletion from HEAD is not
revocation. Revoke/rotate it with the owner; rewriting or deleting history needs
separate authorization. Original delivery tags are not moved for sanitization.

The public source candidate is a fresh file export without `.git`, private
evidence, device snapshots, guest data or restricted binaries. Do **not** simply
change this development repository's visibility or push its old refs publicly.
