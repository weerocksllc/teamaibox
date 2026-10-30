<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.fr.md)
<!-- doc-navigation:end -->

# Team AI Box outils de package hors ligne

Le programme d'installation d'origine est sous licence MIT. Les packages incluent la licence racine, l'inventaire tiers et les textes de licence dans leur inventaire de hachage de fichiers. Cela ne modifie pas la licence des modèles, des services Google, des pilotes ou des dépendances de conteneurs en tant que MIT. Lisez les [limites de version](../docs/open-source/RELEASING.fr.md) avant la distribution ; un package de tests complet existant n’a pas automatiquement l’autorisation de redistribution.

Les clients exécutent **`sudo ./install.sh` dans le package préparé**. Les responsables construisent ce package avec `build-package.sh`. Les clients hors ligne n'ont pas besoin des référentiels Git, Node, Go, pip ou de packages publics.

Pour le téléchargement, la création et l'installation automatiques à partir d'un clone public, exécutez `sudo bash install/from-source.sh`. Les réseaux en Chine peuvent utiliser `--region cn`. Voir [SOURCE-INSTALL.md](SOURCE-INSTALL.fr.md) pour le fonctionnement, la reprise et le transfert hors ligne. Le CV est pris en charge ; seul le résultat final de préparation établit l’achèvement de l’installation. Un contrôle en amont ou un téléchargement réussi ne suffit pas.

La cible est un nouveau DGX Spark avec son système Ubuntu 24.04 ARM64 d'usine et Docker Engine fonctionnel, Compose v2, NVIDIA Container Toolkit/GPU et KVM. Le programme d'installation ne remplace pas Docker/NVIDIA, ne redémarre pas Docker et ne copie pas les comptes, la base de données, les clés ou les machines virtuelles d'une appliance de développement.

> Les enregistrements d'acceptation des installations privées restent dans le référentiel de développement historique. Ce ne sont ni des fichiers sources publics ni des entrées de build. Les preuves existantes de première installation, de reprise et de récupération de démarrage ne sont pas réexécutées uniquement pour la publication de la source, et ne qualifient pas les images arbitraires nouvellement créées ni n'accordent de droits de redistribution pour les binaires tiers.

## Mainteneurs : préparer les entrées de la version

**Pour une nouvelle version publique de GitHub, commencez par [PUBLIC-BUILD.md](PUBLIC-BUILD.fr.md).** Il couvre les images publiques, les temps d'exécution des caméras, les téléchargements/quantifications de modèles et le micrologiciel sans nécessiter d'images provenant d'une appliance de développement. Les assistants d'image en couches ci-dessous prennent en charge les mises à jour incrémentielles des artefacts vérifiés ; ce ne sont pas des conditions préalables à une nouvelle construction.

La préparation peut utiliser Internet. L'installation à partir du package livré ne doit pas télécharger de dépendances. L'hôte d'empaquetage a besoin de Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` et d'un stockage suffisant. Les modèles et les images peuvent être volumineux ; le packager conserve à la fois l'arborescence extraite et `.tar`, estimant l'espace à partir des entrées réelles. Il n'analyse pas l'intégralité d'une appliance de développement et n'exporte pas les couches inscriptibles des conteneurs en cours d'exécution.

1. Préparez les images ARM64 à partir de **une version** pour tous les rôles requis. Utilisez les points d'entrée de build sous `deploy/images/`, `deploy/appliance/` et les répertoires invité/modèle correspondants. L'API de plateforme, l'agent de nœud, le planificateur et le contrôleur d'agent doivent prendre en charge les ID d'image locaux ; l'image PostgreSQL doit contenir le manifeste de migration actuel, y compris la migration 116. Le packager ne compile pas une ancienne image arbitraire en une image actuelle. Avec les images parentes vérifiées de même version, utilisez `build_runtime_images.py --bases … --node-agent-binary … --output …` pour créer les cinq images successives. `--bases` est un mappage JSON rôle-image-ID complet. Créez d’abord l’agent de nœud avec `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`. Cet assistant interdit les extractions/constructions de réseau, enregistre les identités parent/source et crée de nouvelles images sans déployer ni modifier les balises actives. Les ROM Android propres ont également besoin de l'adaptateur réseau de contrôle actuel. Utilisez `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` pour ajouter `phone_network.py` aux deux couches successeurs de ROM sans accès au réseau ni modification des données ROM. Il enregistre les identifiants exacts des images et les résumés des sources. Liez le side-car Android aux deux nouveaux identifiants, pas aux précédents. Créez le Web et neuf applications officielles à l'aide de `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`. Créez d’abord le Web comme spécifié par `apps/web/package.json`. L'assistant utilise des Dockerfiles de production, corrige le répertoire Web à l'adresse `/opt/teamaibox/web` et compare les fichiers image aux hachages d'entrée de build actuels. Ne présumez pas qu’une image de conteneur de développement est une version Web complète : elle peut dépendre de variables de répertoire statique supplémentaires ou contenir un ancien répertoire. Cet assistant hors ligne ne se déploie pas. Mettez les dix nouveaux identifiants d’image dans les entrées de version.
2. Collectez des répertoires complets et propres pour six modèles : configuration, fragments, tokenizers, code requis et licences. Préparez également deux images Android propres, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` et les scripts d'exécution de dessin. Ne collectez pas les répertoires d'instances de téléphone, les disques utilisateur, l'état de connexion Google, les ISO utilisateur ou les informations d'identification globales. Les ROM Android sont déjà à l'intérieur de `phone-runtime` / `phone-google-runtime` ; ne copiez pas un deuxième disque. Les répertoires d'actifs `android-standard` / `android-google` contiennent uniquement la provenance, les licences et `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` et `runtimeImageId: "sha256:…"`. L'ID doit correspondre à l'image d'exécution exportée. Le répertoire du pilote contient uniquement `virtio.iso` ; un répertoire de développement contenant également `windows.iso` est rejeté.
3. Créez les deux outils hôtes Linux ARM64 fournis sans les installer sur l'hôte de construction :

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. Sur un hôte de build ARM64 connecté à Internet, collectez les dépendances de l'outil hôte à l'aide d'une image Ubuntu 24.04 locale explicite. Utilisez l'ID d'image vérifié sur cet hôte, et non un ID copié à partir d'une appliance de développement :

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Collectez uniquement les dépendances pour cryptsetup, ext4, USB/caméras, les outils d'image QEMU, la mise en réseau et les petits utilitaires système. Les packages Docker, containersd, NVIDIA, CUDA et de remplacement du noyau sont interdits. Fournitures d'installation, outils manquants uniquement ; apt lit le référentiel de fichiers local du package avec `--no-download --no-remove`, sans solution de repli en ligne.

5. Générez le manifeste d'entrée de version et fournissez des **chemins d'artefact explicites et des ID de contenu d'image local** :

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   Le modèle comprend les 41 rôles d'image et les 12 catégories d'actifs externes ; un autre actif d'usine est généré par les outils. Les espaces réservés ne peuvent pas entrer dans un package. `sourceCommit` doit correspondre à l'extraction, `agentVersion` à la version réelle de l'agent et `hostPackageCollection` à l'étape 4 `collection.json`. Les chemins d'hôte de build sont des entrées de collection, et non une configuration d'exécution client. Utilisez le générateur d'usine actuel : les itinéraires `drawing.automatic` / `drawing.fast` de l'interface utilisateur du dessin doivent correspondre à la configuration du modèle local. La santé des travailleurs ou un appel de modèle direct ne suffit pas à établir l’état de préparation d’une candidature. L'emballage rejette les modèles d'usine obsolètes qui ne contiennent pas ces mappages.

Le contrat de rôle d'image est signalé par `python3 install/package.py --describe-contract` :

- Core, Web, Team Drive, messagerie, passerelles, planificateur, maintenance, plugins, sandbox d'agent dynamique et passerelles source de package.
- Neuf plugins d'application, six modèles de bureau et des environnements d'exécution ASR/haut-parleur à la demande.
- Android standard, Google Android, exécution informatique et passerelles d'affichage/audio Web.
- Récepteur de casting, traitement des médias et SFU.

Deux rôles peuvent partager un ID de contenu d'image ; son archive n'est exportée qu'une seule fois. Les index de fragments de modèle sont également vérifiés : les hachages de fichiers correspondants n'excusent pas une fragmentation manquante. Les outils hôtes doivent être de véritables binaires ARM64 ELF.

## Construire le package

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

Les sorties sont `teamaibox-<releaseId>-linux-arm64.tar`, son fichier `.sha256` et le répertoire extrait. La copie, l'exportation d'images, le hachage et l'archivage s'effectuent dans un répertoire temporaire avant la publication de la somme de contrôle finale. Les sorties existantes ne sont pas écrasées ; une build interrompue ne doit pas ressembler à une version complète. Pour les modifications réservées au programme d'installation avec des identités d'image inchangées, utilisez `--image-cache <previous-extracted-package>`. L'intégralité de l'ancien package est vérifiée avant que ses archives ne soient réutilisées par l'ID d'image réel, et le nouveau package est à nouveau vérifié. Aucune donnée n'est extraite d'une ancienne couche inscriptible d'installation ou de conteneur. Cela évite d’exporter à nouveau des centaines de Go d’images identiques.

Une version normale nécessite que ses fichiers sources groupés appartiennent au commit Git déclaré. Un `--allow-working-tree` explicite crée un candidat au développement ; ses enregistrements manifestes `candidate: true` et ses fichiers modifiés. L'acceptation ciblée ne transforme pas une source non validée en une version publiée.

Disposition du colis :

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

Vérifiez indépendamment avec `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`. Cela vérifie l'intégrité ; cela ne prouve pas un démarrage réussi sur un nouveau matériel.

## Clients : installation et reprise hors ligne

Lisez le [guide d'installation du package](PACKAGE-README.fr.md). La racine par défaut est `/srv/teamaibox/installation`. LUKS/ext4 est créé uniquement dans le nouveau `volume/data.img`, pas sur le disque système ou les disques existants. Le pool de données utilise le stockage disponible moins une marge de sécurité physique, et non une limite fixe de 256 Gio. Les modèles, les fichiers professionnels et les données des invités résident dans le volume chiffré ; Docker existant gère les images de conteneurs.

Une nouvelle installation crée l'administrateur `admin` avec le mot de passe initial `admin`. Les utilisateurs ordinaires sont créés par l'administrateur. Changez le mot de passe initial avant la livraison/utilisation. Cela s'applique uniquement à une base de données de comptes vide : la reprise, la réexécution, le redémarrage et la mise à niveau ne réinitialisent pas les comptes ou les mots de passe existants. L'identité de l'appareil, les informations d'identification du service, les certificats et les codes de récupération de l'administrateur sont générés indépendamment et ne sont pas copiés à partir d'une autre appliance. La préparation initiale du cache du noyau GPU s'exécute sur l'appliance à l'aide d'outils et de modèles fournis ; les caches compatibles sont conservés. La récupération au démarrage restaure d'abord les données et les services des appareils, puis les services principaux et les travailleurs d'IA individuels. Le programme d'installation s'exécute uniquement pendant l'installation ; il n'ajoute aucun gestionnaire d'installation résident.

Après l'interruption, répétez la commande d'origine. Les étapes terminées sont vérifiées ; ne cachez pas les conflits en supprimant des données ou en recréant des conteneurs. La réexécution d'une installation terminée de la même version ne fait que la vérifier ; différentes versions utilisent le chemin de mise à niveau formel. Les détails de l'échec se trouvent dans `install-state.json`, `readiness.json` et dans les enregistrements d'étape sous la racine d'installation.

## Limites de vérification

Les tests spécifiques à l'installateur utilisent de petits artefacts structurels, des fichiers temporaires et des bases de données/démons Docker hors ligne isolés. Ils ne doivent pas accéder aux bases de données d’entreprise ni monter les disques de VM existants. Une véritable nouvelle installation nécessite un DGX Spark compatible explicitement désigné à cet effet ; n’effacez pas un appareil professionnel. L'acceptation couvre le démarrage minimum, la reprise et la récupération du démarrage pour la nouvelle installation, et non les tests métier sans rapport. La préparation de la version source elle-même n’efface, ne réinstalle ni ne déploie les appareils existants.

Sur un hôte de build, exécutez `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` pour importer le package complet dans un démon Docker distinct avec un cache vide et aucun réseau public. Il n'appelle pas le script de nouvelle installation, n'utilise pas de GPU, ne monte pas les répertoires clients et ne redémarre pas le Docker du système. Son rapport ne revendique pas explicitement l’installation complète du matériel. Les images de test restent dans le répertoire de test dédié, nécessitent de l'espace disque supplémentaire et n'entrent pas dans le magasin d'images du système Docker.
