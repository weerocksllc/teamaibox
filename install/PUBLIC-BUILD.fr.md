<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.fr.md)
<!-- doc-navigation:end -->

# Construire une appliance à partir de la source publique

Le nouveau point d'entrée de l'orchestration est documenté dans [SOURCE-INSTALL.md](SOURCE-INSTALL.fr.md). Il automatise les recettes ci-dessous ; son statut de vérification complète de l’appliance y est indiqué. Ces recettes manuelles restent disponibles pour les mainteneurs et les diagnostics d'étape individuels.

Il s'agit du chemin de la source au package. Il n'importe pas une installation Team AI Box précédente, ses conteneurs, comptes, certificats, invités ou base de données. La machine de construction a besoin d'un accès à Internet ; le package complet résultant s’installe hors ligne. Le client fournit séparément les supports d'installation Windows/Linux.

Utilisez Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 et suffisamment d'espace disque pour les téléchargements de sources, les couches de construction et le bundle final non compressé. La quantification du modèle nécessite également un GPU NVIDIA compatible avec suffisamment de mémoire libre. N'arrêtez pas d'autres charges de travail pour obtenir cette mémoire sans l'autorisation du propriétaire de la machine. Docker et NVIDIA sont des prérequis et non des composants remplacés par le programme d'installation.

Exécutez des commandes à partir d’une nouvelle caisse publique. Définissez `BUILD` sur un nouveau répertoire de construction absolu **en dehors** de la caisse. Les résultats, modèles et rapports ne doivent pas être engagés. Chaque assistant refuse une sortie occupée à moins qu'il ne documente une opération de reprise spécifique. Utilisez les références/ID du rapport réussi, et non les noms d'images copiés depuis la machine de quelqu'un d'autre. Un ID de contenu Docker local n'est pas une référence de registre téléchargeable ; Les arguments parents du Dockerfile nécessitent la balise locale correspondante ou un résumé qualifié en amont.

## 1. Services et applications

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` affecte les **builds** en ligne, pas le réseau de services installé. Les étapes de dépendance de nœud autorisent 2 secondes par tentative de connexion au lieu de la valeur par défaut du nœud de 250 ms. Cela permet aux téléchargements npm officiels d'être utilisables sur des liens à latence plus élevée, y compris les VPN gérés par l'utilisateur, sans changer de registre, sans désactiver IPv6 ou affaiblir les contrôles d'intégrité TLS/package. Le paramètre est un argument au stade de la construction et non un changement d'environnement dans l'application installée. Pour un lien plus lent, les versions Docker directes peuvent remplacer `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`. L'image Web crée ses propres dépendances et actifs verrouillés. Les services de nœud partagent la nouvelle fermeture de dépendance d'API. OCR inclut son adaptateur public ; il n'a pas besoin d'un package de travail non publié provenant d'un autre projet. La traduction utilise l'image vLLM publique épinglée NVIDIA. L'intégration, l'ASR par lots et la diffusion de médias partagent délibérément leurs images d'exécution publiques respectives. L'image informatique construit QEMU 11.1.1 avec signature vérifiée avec prise en charge ARM TPM/PPI, KVM, VNC et PulseAudio, préservant les capacités d'exécution Windows d'origine. Debian fournit des bibliothèques d'exécution, mais son ancien package QEMU ne doit pas remplacer cet exécutable. L'image finale vérifie à la fois la propriété ARM TIS `ppi` et le backend PulseAudio et inclut la ROM du framebuffer RAM correspondante. Consultez [le guide d'exécution de l'ordinateur virtuel](../deploy/windows-computer/README.fr.md) pour connaître la sonde d'exécution limitée et les exigences de mise à jour de préservation des données.

Chaque rôle a un journal. Un rapport ayant échoué préserve les sorties de rôle réussies ; créez uniquement le rôle ayant échoué et fusionnez les rapports réussis ultérieurement. Ne remplacez pas un conteneur de développement en cours d’exécution comme image manquante.

## 2. Runtime Android et appareil photo sans compte

Les verrous épinglent la version AOSP de Google, le package hôte, les entrées du noyau et les révisions des sources. Les téléchargements sont vérifiés avant utilisation. Aucun invité n'est démarré pendant l'assemblage.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

Pour le correctif APK de l'appareil photo, installez les outils de ligne de commande Android publics de Google, la plate-forme `android-36.1`, les outils de construction `36.1.0` et un JDK prenant en charge la version Java.
8. Définissez `ANDROID_SDK_ROOT` and `JDK_HOME` sur ces répertoires d'outils. Les outils sont des dépendances de construction et non des profils utilisateur Android exportés. Sous ARM64 Linux, le package `zipalign` fourni par Google peut être uniquement x86 : installez le package ARM64 `zipalign` d'Ubuntu et transmettez `--zipalign /usr/bin/zipalign` ci-dessous. D8 et apksigner sont des programmes Java. La version APK peut également s’exécuter sur un hôte SDK pris en charge distinct ; transférer uniquement ses deux fichiers de sortie (`Camera2.apk`, `camera-preview.json`), jamais les paramètres Android ou le profil utilisateur de cet hôte.

Extrayez l'APK stock de la version AOSP propre (le répertoire de sortie doit exister et être accessible en écriture par le conteneur de construction) :

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

L'APK conserve le **signataire public du test AOSP** connu, et non une clé de produit privée. L'assistant vérifie le certificat original et résultant ainsi que les ressources APK inchangées, et supprime le matériel de signature temporaire. Il ne s'agit pas d'un compte ni d'une identité d'appareil Google.

Le contrat d'installation complet actuel comprend également une variante expérimentale de Google Android. Son verrouillage public des entrées et son inspection des signatures n'accordent **pas** de droits de certification ou de redistribution à Google. Créez/utilisez-le uniquement dans le cadre des conditions tierces applicables ; ne publiez pas l'ensemble complet résultant en tant que téléchargement MIT sans restriction.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. Fichiers de modèle Publisher et recette de quantification publique

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

Tous les téléchargements de modèles utilisent les révisions immuables dans `deploy/compute/*profile*` et les hachages Git/LFS de l'éditeur. Le `--cache <directory>` facultatif est en lecture seule et accepte les fichiers uniquement lorsque leurs octets correspondent à l'éditeur. Ce n'est pas un moyen d'importer un répertoire de modèle installé sans discernement. Le texte autonome MIT d'ASR est épinglé à la version Whisper d'origine car l'instantané du modèle converti déclare uniquement la licence. OCR conserve sa propre licence, et non MIT. Les cartes de modèle de traduction et d'intégration épinglées déclarent Apache-2.0 sans envoyer son texte autonome ; leurs aides incluent la licence Apache épinglée par somme de contrôle et un enregistrement de provenance après avoir vérifié cette déclaration.

Un téléchargement correspondant interrompu prend en charge `--resume`. `--transfer ranges` utilise des plages HTTP limitées pouvant être reprises ; `--transfer huggingface` nécessite les packages officiels `huggingface_hub`/`hf_xet` et désactive l'utilisation des jetons. Les caches partiels et de téléchargement restent en dehors des répertoires de modèles publiables. Les sommes de contrôle sont obligatoires à chaque transport. Ne les affaiblissez pas pour les pages de connexion/défi HTML ou les téléchargements tronqués.

La quantification s'exécute hors ligne dans un conteneur de construction distinct à l'aide des données d'étalonnage synthétiques publiques de ModelOpt, jamais des historiques de discussion. Seules les sorties dont `build.json` indique `quantized` peuvent fournir `assistant-model` and `translation-model` ; sélectionnez leurs sous-répertoires `model/`, pas les sources brutes ou l'intégralité de l'espace de travail de construction. Après avoir validé les entrées, les versions Linux conseillent au noyau de libérer les pages mises en cache de ces fichiers spécifiques. Cela évite les lectures trompeuses de la mémoire GPU immédiatement libre sur la mémoire partagée du GB10 ; il ne supprime pas les pondérations, n'efface pas les caches à l'échelle de l'hôte et n'arrête pas les charges de travail. Pour un GPU GB10, l'assistant budgétise Linux `MemAvailable` et réserve de la capacité pour l'étalonnage et l'hôte. Il refuse une capacité insuffisante plutôt que d’accepter silencieusement une version majoritairement CPU. Lorsque le modèle complet s'adapte, les budgets ModelOpt explicites évitent le chemin d'exportation inutile de déchargement du processeur d'Accelerate. Le conteneur de build définit également une mémoire verrouillée illimitée et une pile de 64 Mio, conformément aux [NVIDIA exigences de lancement de quantification](https://build.nvidia.com/spark/nvfp4-quantization/instructions). Ces paramètres sont limités au conteneur de build, et non aux limites à l'échelle de l'hôte.

## 4. Compléter les entrées du package

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

La fusion doit signaler **41 rôles et aucun rôle manquant**. Il vérifie l'architecture de l'image/les ID de contenu et rejette les sorties contradictoires. Les ressources contiennent uniquement le micrologiciel UEFI en amont (y compris un nouveau modèle de magasin de variables), un ISO de pilote virtio épinglé par somme de contrôle, un environnement d'exécution de dessin source et des notifications Android liées aux images nouvellement créées. L'ISO n'est pas un support d'installation de Windows. Son miroir Microsoft OpenVMM identique à la somme de contrôle évite de s'appuyer sur une page de téléchargement Fedora interactive.

Collectez les packages hôtes avec `collect_host_packages.py` comme décrit dans [README.md](README.fr.md), puis générez le modèle avec `prepare-release.py --template`. Remplissez sa carte image à partir de `images.json` ; remplissez les 12 rôles d'actifs à partir des sorties du modèle, `resources/assets.json` and `guest-tools`. Définissez `sourceCommit` sur la caisse et la version actuelle de l'agent. Aucun espace réservé ou configuration d’installation précédente n’est acceptable.

Exécutez `prepare-release.py --inputs … --output …`, puis `build-package.sh` en utilisant cette version préparée. Les sources modifiées/non validées nécessitent l'indicateur candidat explicite `--allow-working-tree` ; il ne s'agit pas d'un commit publié. Voir [PACKAGE-README.md](PACKAGE-README.fr.md) pour l'installation. Une nouvelle base de données de comptes vierge obtient `admin/admin` ; toutes les informations d'identification du service et l'identité de l'appareil sont générées indépendamment. Les builds à eux seuls ne prouvent pas que l’installation a réussi.

## Recettes historiques en couches et contrôles de publication

Les anciens fichiers Docker de diagnostic/couches sont conservés pour la maintenance des sources et ne sont pas utilisés par ce pipeline. Leurs arguments `BUILD_PARENT_N` n'ont intentionnellement aucune image privée par défaut. Fournissez un parent compatible que vous avez construit ou utilisez le pipeline public ci-dessus ; ne devinez pas un résumé de développement indisponible.

Avant de publier, exécutez la protection des sources et l'analyseur secret, examinez l'historique séparément et excluez tous les répertoires de build, les packages, les disques invités, les données de compte et le site Web privé. Les rapports contenant des chemins locaux appartiennent en dehors de l’arborescence publique. La vérification de ce travail se limite à la fermeture des entrées de construction, à l'identité des artefacts, à l'installation et aux chemins de service minimaux nouvellement installés ; il ne réexécute pas l'acceptation commerciale sans rapport.
