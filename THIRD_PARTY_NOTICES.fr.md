<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.fr.md)
<!-- doc-navigation:end -->

# Portée de la licence et avis de tiers

Droits d'auteur © 2026 Weerocks LLC. La [MIT licence](LICENSE) couvre le code original Team AI Box et la documentation autorisée par son propriétaire. Il n'accorde pas de licence pour le code tiers, les fichiers en amont copiés/modifiés, les dépendances, les modèles, les micrologiciels, les systèmes d'exploitation, les polices ou les images. Les fichiers de droits d'auteur, de LICENCE et d'AVIS existants prévalent pour leur matériel respectif. Les métadonnées du package `license: MIT` font référence au code d'origine de ce package, et non à tout ce qui est inclus dans une image déployée. `private: true` est conservé pour éviter une publication accidentelle dans le registre des packages ; il ne révoque pas la subvention MIT.

## Inventaire

L'[inventaire des composants](docs/open-source/components.json) lisible par machine enregistre les versions ou les sources des versions, les preuves de licence, la portée de la redistribution et les obligations binaires non résolues. [Inventaire des dépendances](docs/open-source/dependencies.json) est généré à partir du fichier de verrouillage, des métadonnées de dépendance installées, des modules Go et des fichiers d'exigences Python. Les métadonnées de licence manquantes sont explicitement inconnues et ne sont pas supposées MIT. Régénérez-le avec `python3 tools/open_source_inventory.py`.

| Composant / matériau | Limite de licence | Exigences de distribution |
| --- | --- | --- |
| Récepteur UxPlay et `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Conservez la GPL, les notifications, la source exacte en amont, les correctifs et construisez les scripts avec n'importe quel binaire récepteur ; un simple lien vers l'amont est insuffisant pour une version binaire. |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 | Conservez les avis et rendez disponibles les fichiers sources couverts modifiés. |
| GStreamer | Licences LGPL et plugins individuels | Inspectez l’ensemble de plugins réel et remplissez les obligations correspondantes. |
| SDK du serveur/navigateur LiveKit | Apache-2.0 | Conservez les droits d'auteur, la licence et l'AVIS applicable. |
| Seiche / AOSP | Apache-2.0 et licences par fichier, y compris le noyau GPL | Conserver les avis en amont et la source correspondante applicable. AOSP n'inclut pas de licence de services Google. |
| Pilotes QEMU / Linux / EDK II / virtio | Licences par projet et par fichier | Auditer la version binaire réelle, le micrologiciel et les pilotes ; ne pas étiqueter globalement MIT. |
| Guacamole | Apache-2.0 | Conservez la LICENCE et l'AVIS copiés par le Dockerfile du plugin informatique. |
| Arbre de dépendances Node / React / Vite et JS | Licences par package | Conservez les avis de dépendance lors de la distribution de la sortie groupée. |
| Packages PostgreSQL et OS de conteneur | PostgreSQL / par package | Incluez les enregistrements de licence du package installé dans une version binaire. |
| PyMuPDF / MuPDF utilisé par OCR | AGPL-3.0-or-later ou licence commerciale | La distribution/service combiné des travailleurs OCR n'est pas global MIT ; se conformer aux obligations de l'AGPL ou obtenir des droits commerciaux. Le code d'origine peut conserver sa subvention MIT. |
| Actifs du modèle Qwen / LMT / Whisper / FLUX | Termes exacts du modèle | Les modèles sont distincts de la subvention source MIT. Les termes FLUX **4B** ne doivent pas être remplacés par un autre modèle FLUX. |
| Poids HunyuanOCR | Licence communautaire Tencent Hunyuan | Licence de modèle conditionnelle ; examiner les conditions de destinataire, de territoire, d’utilisation, d’attribution et de redistribution pour chaque version. |
| NVIDIA logiciel | NVIDIA et conditions tierces incluses | L'installation Docker/NVIDIA de l'hôte existant n'est pas redistribuée par ce package source. Les bibliothèques groupées CUDA/conteneurs ont toujours besoin de leur propre révision. |
| Services mobiles Google/Play Store | Propriétaire | Ne fait pas partie du candidat de source publique. Le code d'intégration d'exécution n'accorde pas le droit de distribuer des images GMS. |
| Support d'installation Windows, disques invités, comptes | Non couvert | Les utilisateurs fournissent des supports et des licences ISO autorisés. N’envoyez jamais de disques de VM de test ou d’état d’invité connecté. |
| SDK ViKey retiré | Propriété exclusive / aucune subvention publique établie | SDK supprimé de la source de travail ; les commits historiques privés et les copies du SDK conservées ne doivent pas être publiés. Aucune clé USB n'est requise. |

Les avis de diffusion exacts restent dans [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt). Les avis de transport ADB restent à côté du client téléphonique. Ne les retirez pas lors de la réduction ou de l'emballage. L’isolation des conteneurs en elle-même n’annule pas les obligations de copyleft. L'analyse de distribution dépend de l'artefact combiné réel.

## Marque et contributeurs

MIT accorde une autorisation de droit d'auteur, et non des droits de marque ou une approbation. Les noms/logos Team AI Box et Weerocks ne doivent pas impliquer un support officiel pour un produit modifié. NVIDIA, DGX Spark, Android, Google Play, Windows et Apple/AirPlay appartiennent à leurs propriétaires respectifs. La compatibilité n'est pas une certification.

Les métadonnées des auteurs locaux sont un inventaire et non une preuve de cession des droits d'auteur. Les catégories de propriété examinées sont enregistrées dans [OWNERSHIP.md](docs/open-source/OWNERSHIP.fr.md). L'autorisation du porteur de projet s'applique à ses apports originaux ; les contributeurs doivent soumettre uniquement les travaux pour lesquels ils ont droit à une licence. Attribution manquante présumée : teamaibox@weerocks.llc.
