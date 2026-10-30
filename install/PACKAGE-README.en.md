<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.md)
<!-- doc-navigation:end -->

# Team AI Box offline installation package

The license for original code is in the bundled `LICENSE`. Third-party components retain their original licenses; see `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT grants no additional redistribution rights for Google services, Windows, model weights or third-party brands. Passing package integrity checks does not establish redistribution permission for every component.

This package is for a fresh DGX Spark retaining a compatible factory Linux system. It uses the existing Docker, Compose and NVIDIA GPU environment without replacing them or formatting the system disk.

## Installation

Verify the archive using the accompanying `.sha256` file, then extract it:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

Normal installation needs neither public internet access nor manual environment-variable edits. The installer supplies required bundled tools, generates independent local configuration, initializes a new database and starts services. Initial model loading can take time; a loading indicator is not confirmation of successful installation.

Run `sudo ./install.sh --check` to check the environment and package without installing. `./install.sh --verify-package` checks package contents only and can also run on the packaging workstation. Use `--installation-root /dedicated/path/installation` to specify a new installation root; never point it at existing data.

## Interruptions and existing data

After a failure or interruption, resolve the reported problem and repeat the original command. Do not delete the installation directory. The installer preserves the identity and data it generated. Rerunning a complete same-version installation only checks its state. Other versions use the formal upgrade path, not erasure and reinstallation. There is no force-overwrite option.

## First use

Open the HTTPS address at the appliance's current IP and sign in:

- Administrator username: `admin`
- Initial password: `admin`

The installer creates this administrator automatically; no setup token extraction or manual registration is needed. The initial password is public and simple: change it in user management before delivery/use. Ordinary users have no default account and are created by the administrator. This applies only to an empty account database; resume, rerun, reboot and upgrade never reset existing accounts or passwords to defaults. The independently generated administrator recovery code is stored under the installation root at `secrets/initial-owner-recovery.json`, readable only by root. Never send recovery codes to chats, tickets or public logs. Existing installations do not generate or replace recovery codes. For the locally issued HTTPS certificate, configure browser trust according to the administrator's CA instructions. A name in a certificate does not guarantee LAN DNS/mDNS resolution. The local CA public certificate is normally at `/srv/teamaibox/installation/https/ca.crt`. Distribute only that public certificate, never the private key beside it.

Installation does not include existing virtual machines, Google login state or user files. Users upload Windows/Linux ISOs or select them from the team drive, then install the guest systems themselves. Google Play and external APIs require internet access and are not included in the offline-availability promise.

Component license texts are retained with their release resources. Copyright © Weerocks LLC.
Contact: teamaibox@weerocks.llc.
