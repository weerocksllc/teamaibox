<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.fr.md)
<!-- doc-navigation:end -->

# Limite de confidentialité des sources publiques

Le référentiel de produits public est un nouvel instantané des sources, et non un miroir de l'historique de développement privé. Le site Web marketing possède son propre référentiel privé et n'est pas inclus ici.

## Matériel supprimé

- Correction des noms et mots de passe des comptes de test de déploiement et des listes de comptes personnels.
- Wrappers et scripts de déploiement/récupération sur un seul appareil qui enregistraient les identités historiques des appareils ou affirmaient les résultats à partir de preuves privées.
- Adresses d'hôtes réelles, répertoires personnels, identités de conteneurs/périphériques et instantanés de maintenance historiques. Les tests retenus utilisent des montages explicitement synthétiques ; les outils opérationnels maintenus nécessitent des entrées cibles explicites.
- Les disques invités, l'état de connexion Android, les sessions du navigateur, les packages d'installation, les poids des modèles et les preuves privées sont en dehors de la distribution source publique.

Les archives privées et les étiquettes de livraison originales restent intactes. Rien dans ce nettoyage de source ne modifie les comptes de l'appliance, les données des invités, les services en cours d'exécution ou le déploiement de sites Web. La valeur par défaut d'usine `admin / admin` est délibérément conservée ; ce n'est pas un identifiant privé. Les administrateurs doivent le modifier avant l'exposition.

## Examen et vérification

Examinez à la fois l'arbre de travail et chaque validation/balise accessible dans le référentiel en cours de publication. Utilisez Gitleaks plus `tools/open_source_sensitive.py` ; ni l’un ni l’autre ne prouvent que les mots de passe à faible entropie ou les métadonnées personnelles sont absents. Comparez les anciennes valeurs privées confirmées à l'aide d'une liste noire externe privée, jamais d'un appareil de test validé. Examinez les résultats restants individuellement, y compris les fichiers de test.

Les contrôles de nettoyage concernent la politique source, la régression synthétique, la configuration et la syntaxe. Ils ne se connectent pas à l’aide d’informations d’identification découvertes, ne réinstallent pas une boîte ou ne répètent pas l’acceptation du produit. La correction précédente du packaging de l'API (y compris la source de l'interface utilisateur partagée et la vérification du point d'entrée pour l'importation uniquement) reste dans la source.

Les nouveaux clones ne doivent pas importer de commits, de références ou de balises retirés. La suppression d'un référentiel ne rappelle pas les copies déjà téléchargées par d'autres. Aucune analyse ne peut établir qu'un identifiant inconnu n'a jamais été copié ; un identifiant qui a été réellement utilisé doit être alterné par son opérateur. Ce nettoyage ne prétend pas l'avoir fait pivoter.

Voir [RELEASING.md](RELEASING.fr.md) pour les instructions d'exportation et de révision des sources et [BUILDING.md](BUILDING.fr.md) pour les prérequis de construction et les ressources obtenues séparément.
