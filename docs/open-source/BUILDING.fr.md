<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.fr.md)
<!-- doc-navigation:end -->

# Construire la source

L’artefact public est la source et non une image d’appliance hors ligne prédéfinie. Une version source peut télécharger des dépendances ; l'installation à l'aide d'un package complet préparé reste hors ligne. Aucun des deux processus n’a besoin d’un SDK ViKey ou d’une clé USB.

Pour une installation complète de l'appliance, commencez par la racine [démarrage rapide](../../README.fr.md#install) et [programme d'installation source](../../install/SOURCE-INSTALL.fr.md) : `sudo bash install/from-source.sh` téléchargements, builds, packages et installations sur un nouveau Spark compatible. La version Web de développement ci-dessous n'est pas ce programme d'installation et ne démarre pas le produit complet.

## Développement

Utilisez Node.js 24, pnpm 11.1.3 (voir racine `package.json`), Python 3.10+ et la version Go déclarée dans chaque `go.mod` (node-agent actuellement 1.26). Sur une machine de build :

Une exportation source n’a délibérément pas d’historique Git privé. Avant d'exécuter les outils source sur cette arborescence exportée, initialisez votre propre référentiel et validez votre arborescence révisée (`git init`, `git add .`, `git commit`). Un clone Git public normal n’a pas besoin de cette étape. Utilisez ce nouveau commit comme identité de build ; ne prétendez pas qu'un arbre modifié et exporté est l'ancien commit de livraison.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

La construction Web est une vérification de compilation et non une acceptation du produit. Les services d'exécution utilisent les Dockerfiles sous `deploy/`. L'exécution de DGX Spark nécessite Linux ARM64 et l'environnement NVIDIA/Docker existant. Une extraction de source de bureau ne remplace pas ce matériel. N’utilisez pas de scripts de laboratoire historiques comme installateurs.

Les assistants de construction d'usine Python nécessitent en outre PyYAML ; voir le contrôle en amont des dépendances du programme d'installation. Aucun disque de système d'exploitation installé ni aucun compte de développeur n'est requis.

## Entrées compilées exclues

L'exportateur omet les fichiers binaires, même lorsque leur extension semble inoffensive :

- Construisez `services/node-agent` et son assistant `cmd/factory-worker-spec` à partir de la source Go ; l'exécutable racine du référentiel `node-agent` n'est pas une entrée source.
- Les fichiers APK et les fichiers de signature des appareils Android ne sont pas expédiés. Leur source et leurs manifestes sous `tools/fixtures/` restent disponibles pour les versions de test locales.
- La version actuelle de diffusion de l'appliance utilise `deploy/appliance/wireless-casting-plugin.Dockerfile`. Il n’a pas besoin des anciennes archives du package Alpine. Si vous utilisez plutôt le plugin autonome Dockerfile, obtenez les packages exacts identifiés dans [son manifeste de somme de contrôle en amont](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) et vérifiez leurs valeurs SHA-256 avant de créer. Ne remplacez jamais un package arbitraire lorsque l’artefact en amont épinglé n’est pas disponible.
- Le module navigateur LiveKit et sa licence restent dans le répertoire source public du plugin ; l'archive npm redondante `.tgz` n'est pas livrée.

Il s’agit d’exclusions de distribution source et non de modifications apportées à l’appliance en cours d’exécution.

## Package hors ligne complet

Commencez par [le pipeline source publique](../../install/PUBLIC-BUILD.fr.md). Il fournit les images parentes publiques et les dépendances d'exécution créées à la source ; une installation préalable du développeur n'est pas requise. Les recettes d'images en couches historiques ne constituent pas le point d'entrée d'une nouvelle installation.

Suivez [install/README.md](../../install/README.fr.md) pour les versions d'image d'application, les outils d'hôte invité, les packages d'hôte hors ligne, la collecte d'actifs et l'emballage final. L'appliance cible ne récupère pas les dépendances et ne remplace pas Docker/NVIDIA. Définissez les entrées de construction sur votre validation source réelle, les ID de contenu ARM64 OCI et les chemins d'actifs propres. Aucune adresse IP, compte, certificat ou volume d'hôte de développement n'est requis. Les pondérations du modèle et les actifs invités/d'exécution sont obtenus séparément des sources en amont exactes identifiées dans [components.json](components.json) et des verrous du référentiel. Conservez leurs licences et les avis de source requis.

**La disponibilité de la source n'est pas une autorisation de redistribution binaire.** Le contrat actuel complet du package hors ligne comprend un environnement d'exécution Google Android ; sa preuve d'installation privée ne constitue pas une autorisation de distribuer GMS. Le packager existant reste inchangé, mais un tel package ne constitue pas un téléchargement public approuvé à moins que ces droits ne soient obtenus. Une édition binaire publique uniquement AOSP constituerait un changement d'emballage de portée distincte, qui ne serait pas silencieusement remplacé ici. Les fichiers ISO Windows/Linux sont fournis par chaque utilisateur ; aucun invité de test installé ni état de compte n'est une entrée de build publique.
