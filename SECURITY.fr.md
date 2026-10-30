<!-- doc-navigation:start -->
[English](SECURITY.md) · [简体中文](SECURITY.zh-CN.md) · [繁體中文](SECURITY.zh-TW.md) · [日本語](SECURITY.ja.md) · [한국어](SECURITY.ko.md) · [Français](SECURITY.fr.md) · [Deutsch](SECURITY.de.md) · [Español](SECURITY.es.md) · [Português](SECURITY.pt-BR.md) · [Русский](SECURITY.ru.md) · [العربية](SECURITY.ar.md) · [हिन्दी](SECURITY.hi.md) · [Bahasa Indonesia](SECURITY.id.md) · [Italiano](SECURITY.it.md) · [Türkçe](SECURITY.tr.md) · [Tiếng Việt](SECURITY.vi.md) · [ไทย](SECURITY.th.md)

[Team AI Box — README](README.fr.md)
<!-- doc-navigation:end -->

# Rapports de sécurité

Veuillez signaler les vulnérabilités suspectées en privé à **teamaibox@weerocks.llc**. Incluez la version concernée, la reproduction minimale, l’impact et les journaux expurgés. Ne mettez pas d’informations d’identification, de contenu client et n’exploitez pas les détails dans les problèmes publics. Demandez un canal de transfert sécurisé approprié avant d’envoyer des fichiers sensibles. Aucune garantie de temps de réponse ni certification de sécurité indépendante n'est revendiquée.

Les nouvelles installations hors ligne utilisent actuellement l'administrateur d'amorçage documenté `admin` / `admin` ; modifiez ce mot de passe avant d’exposer l’appliance à des utilisateurs ou à un réseau non fiable. Il s'agit d'un identifiant initial public, et non d'un secret à cacher dans la liste autorisée d'un scanner. Aucun compte utilisateur ordinaire n'est créé automatiquement. La modification de ce comportement d'intégration ne fait pas partie de ce changement de licence.

## Examen des sources/historiques

Consultez [la limite de confidentialité de la source publique](docs/open-source/SOURCE-PRIVACY.fr.md) pour connaître les données exclues, l'examen de l'historique et les responsabilités en matière de rotation des informations d'identification.

Exécutez le scanner local épinglé comme décrit dans [préparation de la version](docs/open-source/RELEASING.fr.md). Les rapports sont privés, rédigés et jamais téléchargés sur un service d'analyse externe. Si un véritable identifiant apparaît dans l'historique privé, la suppression de HEAD n'est pas une révocation. Le révoquer/le faire pivoter avec le propriétaire ; la réécriture ou la suppression de l'historique nécessite une autorisation distincte. Les étiquettes de livraison originales ne sont pas déplacées pour la désinfection.

La source publique candidate est une nouvelle exportation de fichier sans `.git`, preuves privées, instantanés d'appareil, données d'invité ou binaires restreints. Ne **pas** simplement modifier la visibilité de ce référentiel de développement ou diffuser publiquement ses anciennes références.
