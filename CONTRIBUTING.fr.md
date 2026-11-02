<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.fr.md)
<!-- doc-navigation:end -->

# Contribuer

Merci d'avoir contribué à l'amélioration de Team AI Box. Nous accueillons les nouveaux contributeurs : les rapports de bogues, les traductions, la documentation, l'accessibilité, les intégrations d'applications et les modifications de code ciblées comptent tous. Vous n'avez pas besoin d'un DGX Spark pour améliorer des documents ou des composants qui peuvent être vérifiés indépendamment.

## D'une idée à une pull request

1. Recherchez [problèmes existants](https://github.com/weerocksllc/teamaibox/issues). Décrivez le problème de l'utilisateur, le comportement attendu, le comportement réel et la version pertinente. Discutez de changements plus importants avant d’investir dans une mise en œuvre.
2. Forkez le référentiel public et clonez votre fork. Créez une branche ciblée ; n'incluez pas le site Web de marketing privé, les données d'exécution ou les modèles téléchargés.
3. Suivez [BUILDING](docs/open-source/BUILDING.fr.md) pour les builds de nœuds, pnpm et de composants locaux. Le programme d'installation d'un nouvel appareil est un flux de travail différent : ne l'exécutez jamais sur une machine contenant des données commerciales uniquement pour développer l'interface utilisateur.
4. Apportez la moindre modification cohérente, mettez à jour la documentation concernée et effectuez les vérifications pertinentes. Expliquez toutes les vérifications dépendantes du matériel que vous n'avez pas pu exécuter.
5. Ouvrez une pull request décrivant le problème, la solution, l'impact de la compatibilité et les vérifications. Incluez des captures d'écran nettoyées pour les modifications visibles. Répondre aux commentaires d'examen ; les responsables examinent avant de fusionner.

Un espace de travail OpenSpec local est facultatif et n'est pas publié dans ce référentiel. Les contributeurs publics peuvent soumettre une proposition et des critères d'acceptation directement dans un numéro ou un PR ; aucune spécification privée manquante n’est requise pour participer.

## Traductions et captures d'écran

Pour la liste détaillée des fonctionnalités, modifiez `docs/readme-features/<locale>.json` ; conservez les identifiants et l’ordre des groupes et des éléments de la version anglaise, et maintenez les références au code source dans `docs/readme-features/evidence.json`.

Les 17 langues du produit disposent d'un fichier README. Modifiez `docs/readme-locales/<locale>.json`, puis exécutez `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`. Ne modifiez pas manuellement les README générés. La liste des paramètres régionaux provient de `packages/ui-system/src/locale-registry.mjs`. Les guides d'installation, de construction, de contribution, de sécurité et de licence liés utilisent les mêmes 17 langues. Leur liste de documents se trouve dans `docs/document-locales/manifest.json`. Modifiez la page en langue source et les traductions des paragraphes dans `docs/document-locales/<locale>.json`, puis exécutez `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`. Les clés de traduction sont des hachages SHA-256 des paragraphes sources ; un changement de source fait échouer le moteur de rendu jusqu'à ce que les traductions correspondantes soient mises à jour. Les exemples de code sont partagés textuellement et des liens vers des documents sont générés pour la langue sélectionnée. Les nouvelles traductions sont des brouillons assistés par machine avec un code et des liens protégés ; une révision linguistique et terminologique est la bienvenue. La génération et les contrôles s'exécutent localement, sans service de traduction, sans clé API ni accès à une appliance. Consultez [la politique de capture d'écran](docs/assets/screenshots/README.fr.md) avant d'ajouter des images publiques. Les traductions, y compris la terminologie et le phrasé naturel, sont des contributions de révision bienvenues.

## Règles de contribution

- Les contributions originales sont soumises sous la licence MIT du référentiel. Conservez les en-têtes tiers et indiquez la source/licence du matériel copié. Aucune CLA obligatoire distincte ou autorisation de contributeur rémunéré n’est requise.
- Utilisez Node 24 et la version pnpm épinglée dans `package.json`. Les exigences Python et Go sont décrites dans [BUILDING](docs/open-source/BUILDING.fr.md).
- Exécutez uniquement les tests pertinents pour votre modification et signalez exactement ce qui a été exécuté. Un appareil local ne constitue pas une revendication d'acceptation réelle de l'appareil. Ne répétez pas et n’effacez pas les résultats d’acceptation historiques simplement pour clôturer une modification de documentation.
- Ne testez jamais la suppression, la réinstallation ou la récupération des données d'un utilisateur. Utilisez des luminaires synthétiques ou des ressources temporaires explicitement désignées.
- Pas de clés privées, de jetons, de cookies, d'invites/fichiers client, d'images d'invités connectés, d'instantanés de déploiement privé ou de captures d'écran personnelles dans les problèmes/PR. Voir [SÉCURITÉ](SECURITY.fr.md) pour les rapports privés.
- Conservez `private: true` sur les packages d'espace de travail. Ne réécrivez jamais l’historique Git partagé, ne déplacez jamais les balises de livraison et ne publiez jamais d’artefacts de build privés dans le cadre d’une PR.

Documentez les tests, migrations et changements de comportement pertinents dans votre contribution. Les vérifications dépendant du matériel doivent identifier la configuration et les limites réelles.
