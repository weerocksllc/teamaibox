<!-- doc-navigation:start -->
[English](OWNERSHIP.md) · [简体中文](OWNERSHIP.zh-CN.md) · [繁體中文](OWNERSHIP.zh-TW.md) · [日本語](OWNERSHIP.ja.md) · [한국어](OWNERSHIP.ko.md) · [Français](OWNERSHIP.fr.md) · [Deutsch](OWNERSHIP.de.md) · [Español](OWNERSHIP.es.md) · [Português](OWNERSHIP.pt-BR.md) · [Русский](OWNERSHIP.ru.md) · [العربية](OWNERSHIP.ar.md) · [हिन्दी](OWNERSHIP.hi.md) · [Bahasa Indonesia](OWNERSHIP.id.md) · [Italiano](OWNERSHIP.it.md) · [Türkçe](OWNERSHIP.tr.md) · [Tiếng Việt](OWNERSHIP.vi.md) · [ไทย](OWNERSHIP.th.md)

[Team AI Box — README](../../README.fr.md)
<!-- doc-navigation:end -->

# Portée du droit d'auteur et de la provenance

MIT est appliqué sur instruction du porteur de projet aux contributions originales de Team AI Box attribuées à Weerocks LLC. Les noms d'auteurs Git sont une provenance utile, et non une preuve d'emploi, de cession ou d'autorité pour autoriser le travail de tiers. L'histoire locale examinée comporte 20 commits accessibles et deux identités d'auteur ; Les coordonnées personnelles de l'auteur et les enregistrements de développement privés ne sont pas copiés dans l'exportation source. Aucune cession signée ou autorisation supplémentaire du fournisseur n'est déduite de cet historique.

| Matériel | Traitement des licences | Preuves et limites |
| --- | --- | --- |
| Application/services/packages d'origine et code d'installation | MIT | Instruction du maître d'ouvrage ; LICENCE racine et métadonnées du package ; les en-têtes tiers existants remplacent cette valeur par défaut |
| Modifications UxPlay et matériel de construction associé | GPL-3.0-only | Licence en amont existante, validation épinglée et avis de source correspondante dans `deploy/legal/` ; pas de licence sous le nom MIT |
| Modifications WebRTC de GStreamer | MPL-2.0 | Licence en amont au niveau du fichier et enregistrements de correctifs/builds épinglés |
| Bibliothèques de texte groupées et dépendances normales | Licences originales | Inventaire des fichiers de verrouillage, notifications conservées et métadonnées du registre de version exacte ; les métadonnées sont un index et non un remplacement des textes de licence |
| Dépendance PDF OCR PyMuPDF | AGPL-3.0-or-later ou licence commerciale | Version 1.26.4 et conditions de double licence en amont ; MIT n'accorde pas d'exception commerciale et ne résout pas les obligations de services combinés |
| Poids des modèles, invité Android, firmware et temps d'exécution GPU | Spécifique au composant | Voir `components.json` ; les droits d'origine des sources ne permettent pas automatiquement la redistribution de tous les poids ou combinaisons binaires |
| Google Play/GMS | Propriétaire; pas dans l'artefact de source publique | Le code d'intégration est distinct des images d'exécution propriétaires ; l'utilisation de tests privés existants n'est pas une autorisation de redistribution |
| SDK ViKey retiré et manuel/en-tête du fournisseur | Exclu; droits originaux réservés | Supprimé de l'arborescence source actuelle ; conservé en privé, sans nouvelle licence |
| Journaux privés, données de compte, disques de VM, certificats et ancien historique Git | Exclus | Pas de subvention publique de redistribution ; l'exportation source ne contient aucun historique privé |
| Site Web marketing, modèles d'articles, contenu du site Web et configuration du déploiement (`website/`) | Exclus de la distribution publique des sources de produits | Conservé séparément dans le référentiel du site Web privé ; GitLab est une archive historique ; distinct de l'interface utilisateur de l'appliance dans `apps/` |

Ne supprimez pas les déclarations de droits d'auteur en amont, n'attribuez pas de travail externe à Weerocks et ne supposez pas que toutes les variantes de modèles portant des noms similaires ont les mêmes termes. Un contributeur doit avoir le pouvoir de soumettre son travail ; aucune nouvelle CCT obligatoire n’est introduite. Consultez les [avis tiers](../../THIRD_PARTY_NOTICES.fr.md) pour les sources des composants et les [limites de version](RELEASING.fr.md) pour la distinction source/binaire.
