# Copyright and provenance scope

MIT is applied on the project owner's instruction to original Team AI Box
contributions attributed to Weerocks LLC. Git author names are useful provenance,
not proof of employment, assignment or authority to license third-party work.
The reviewed local history has 20 reachable commits and two author identities;
personal author contact details and private development records are not copied
to the source export. No signed assignment or additional supplier permission is
inferred from that history.

| Material | License treatment | Evidence and limits |
| --- | --- | --- |
| Original application/services/packages and installer code | MIT | Project owner's instruction; root LICENSE and package metadata; existing third-party headers override this default |
| UxPlay modifications and accompanying build material | GPL-3.0-only | Existing upstream license, pinned commit and corresponding-source notices in `deploy/legal/`; not relicensed as MIT |
| GStreamer WebRTC modifications | MPL-2.0 | File-level upstream license and pinned patch/build records |
| Bundled text libraries and normal dependencies | Original licenses | Lockfile inventory, retained notices and exact-version registry metadata; metadata is an index, not a replacement for license texts |
| OCR PDF dependency PyMuPDF | AGPL-3.0-or-later or commercial license | Version 1.26.4 and upstream dual-license terms; MIT does not grant a commercial exception or resolve combined-service obligations |
| Model weights, Android guest, firmware and GPU runtimes | Component-specific | See `components.json`; original source rights do not automatically permit redistribution of all weights or binary combinations |
| Google Play/GMS | Proprietary; not in public source artifact | Integration code is distinct from proprietary runtime images; existing private test use is not redistribution permission |
| Retired ViKey SDK and vendor manual/header | Excluded; original rights reserved | Removed from current source tree; retained privately, not given a new license |
| Private logs, account data, VM disks, certificates and old Git history | Excluded | No public redistribution grant; source export contains no private history |
| Marketing website, article templates, website content and deployment configuration (`website/`) | Excluded from public product source distribution | Maintained separately in the private GitLab repository; distinct from the appliance UI in `apps/` |

Do not remove upstream copyright statements, attribute external work to Weerocks,
or assume all similarly named model variants have the same terms. A contributor
must have authority to submit their work; no new mandatory CLA is introduced.
See [third-party notices](../../THIRD_PARTY_NOTICES.md) for component sources and
[release boundaries](RELEASING.md) for the source/binary distinction.
