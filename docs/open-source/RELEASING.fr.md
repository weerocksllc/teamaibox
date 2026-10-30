<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.fr.md)
<!-- doc-navigation:end -->

# Libérer les limites

## Séparer les artefacts

1. **MIT source candidate** : code original, spécifications actuelles, outils et avis de construction/test révisés ; pas d'historique Git ni de preuves de laboratoire privé.
2. **Matériel tiers** : sources/binaires/modèles en amont exacts avec leur propre licence et attribution. Les obligations de source de copyleft voyagent avec les binaires.
3. **Pack complet d'appareils hors ligne** : construit par `install/` ; pas automatiquement de licence pour la redistribution publique. Les composants GMS, HunyuanOCR, NVIDIA et les licences invité/micrologiciel nécessitent un examen spécifique à l'artefact. Ne publiez pas le package privé, les ensembles de modèles ou les images connectées sous l'étiquette MIT.
4. **Site Web marketing** : `website/`, y compris ses modèles d'articles, son contenu, ses actifs de conception, ses analyses et sa configuration de déploiement, reste dans le référentiel GitHub privé `weerocksllc/teamaibox.com`. GitLab est une archive historique, pas un référentiel de développement de sites Web. Le site Web ne fait pas partie de la distribution publique des sources de produits. L'interface utilisateur du navigateur de l'appliance dans `apps/` fait toujours partie du produit open source.

Les scripts historiques de déploiement, de récupération et d'enregistrement de preuves sur un seul appareil ne sont pas des outils de produit réutilisables. La politique de publication exclut les scripts et les instantanés retirés ; ne les restaurez pas à partir des archives privées. Les outils conservés nécessitent des cibles explicites fournies par l'opérateur au lieu des hôtes, des comptes, des conteneurs ou des fichiers de preuves d'un développeur. Exécutez l'analyse sensible supplémentaire ainsi que Gitleaks : les identifiants d'appareil, les identifiants de conteneur, les hachages GSF et les noms de comptes personnels testent les métadonnées même lorsqu'ils ne sont pas des informations de connexion utilisables. Le nettoyage de l'historique public nécessite l'autorisation explicite du propriétaire et ne doit jamais réécrire l'archive privée ou ses balises de livraison. Après une réécriture autorisée, utilisez un nouveau clone public plutôt que de fusionner l'historique retiré dans le référentiel maintenu.

Le référentiel de développement interne et ses balises restent intacts. Son historique accessible contient d'anciens enregistrements de déploiement et des actifs SDK propriétaires retirés ; il ne doit pas être rendu public tel quel. Un nouvel arbre exporté fournit le point de départ public sans réécrire silencieusement l’historique de livraison d’origine.

## Préparation locale

Utilisez **Gitleaks 8.30.1**, téléchargé à partir de sa version officielle GitHub et vérifiez sa somme de contrôle. L'outil d'audit n'installe jamais de packages système ni ne télécharge de données. La sortie privée est ignorée `.runtime/open-source-audit/`, pas un PR public.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

Les résultats doivent être de nouveaux chemins ; les outils n’écrasent jamais les candidats précédents. Examinez les emplacements expurgés, pas seulement les comptes. Documentez séparément les appareils synthétiques, les informations d'identification publiques d'amorçage, les faux positifs d'identification et les informations d'identification privées réelles/possibles. Les analyses de signatures ne peuvent pas valider les informations d'identification ou les captures d'écran OCR. Les artefacts binaires sont exclus et non déclarés numérisés. L'exportateur source n'admet que les fichiers connus par Git et les entrées explicites non suivies dans [release-policy.json](release-policy.json). Les nouvelles entrées non suivies doivent être examinées. Il rejette les liens symboliques et la traversée de chemin et émet des exclusions SHA-256 plus par fichier. `website/` est toujours exclu, même s'il est suivi ou répertorié comme entrée non suivie. Ne copiez jamais le répertoire `.git` du référentiel privé dans une extraction publique. Avant de publier, vérifiez que l'arborescence et tous les commits publics accessibles ne contiennent aucun fichier de site Web ; la suppression de fichiers lors d'une validation ultérieure ne supprime pas l'ancien historique.

La vérification supplémentaire inclut les messages de validation/balise accessibles, les informations d'identification à faible entropie et les littéraux de connexion, les identités des appareils et les adresses de développement. Les tests ne sont pas automatiquement exonérés : expliquez pourquoi chaque luminaire retenu est synthétique. Les valeurs privées connues peuvent être fournies avec `--denylist` sous forme de tableau JSON externe d'enregistrements `{id, value, word?}`. Utilisez des identifiants opaques et non sensibles ; conservez ce fichier en dehors de l'extraction des sources. Les rapports affichent les emplacements et les hachages, jamais les valeurs. Une correspondance de marqueur connue fait échouer la vérification. Utilisez `--scope worktree` pendant le nettoyage ; inspectez `--scope all` dans le nouveau référentiel de version sans parent avant de publier. Ne publiez pas l’ancien historique ou les rapports d’examen privés.

La seule valeur par défaut intentionnelle de l'administrateur d'usine est `admin / admin` ; changez-le pendant le déploiement. Les outils de test de déploiement/navigateur doivent recevoir les informations d’identification du compte existant via une entrée locale protégée. Les comptes de test de fumée nouvellement créés utilisent des informations d'identification aléatoires et sont désactivés lors du nettoyage. Un échec de nettoyage est un échec de test et non une exécution réussie. L'arrêt brutal du processus peut empêcher le nettoyage ; les opérateurs doivent réconcilier leurs comptes temporaires après une telle interruption. Aucun document public ne prétend qu'un titre de test est actuellement valide.

Seul le point d'entrée `install/` géré est un chemin d'installation d'appliance propre. L'évaluation de la propriété des composants se trouve dans [OWNERSHIP.md](OWNERSHIP.fr.md).

Aucune commande ici ne pousse Git, ne modifie la visibilité, ne réécrit l'historique, n'effectue la rotation des informations d'identification en direct, ne modifie un appareil ou n'accorde des droits de redistribution à des tiers. La diffusion publique nécessite une destination publique explicitement choisie et un examen final des artefacts. Conservez `delivery-2026-10-22` dans le référentiel privé.
