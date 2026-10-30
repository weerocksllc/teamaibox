<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.fr.md)
<!-- doc-navigation:end -->

# Installer à partir d'un clone public

Ce point d'entrée prépare les entrées publiques requises, crée les images de l'application et produit un package complet avant de l'installer. La progression de la construction peut être reprise ; seul le résultat final de préparation à l’installation indique un appareil installé. Le succès du téléchargement ou du contrôle en amont ne suffit pas à lui seul.

Conservez les modèles générés, les images de conteneurs, les packages d'installation, les enregistrements de test et les informations d'identification en dehors du référentiel. La disponibilité des miroirs tiers n'est pas garantie ; les caches portables vérifiés et les packages hors ligne sont décrits ci-dessous.

Sur un nouveau DGX Spark avec Ubuntu 24.04, fonctionnant avec Docker/Compose, NVIDIA et KVM, clonez le référentiel public et exécutez-le à partir de sa racine :

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Pour un réseau de Chine continentale où les points de terminaison du modèle/image en amont ne sont pas accessibles, utilisez le même point d'entrée avec les sources de téléchargement régionales :

```sh
sudo bash install/from-source.sh --region cn
```

Il s'agit d'une **version source en ligne suivie d'une installation hors ligne**, et non d'une version source hors ligne. Il prépare automatiquement les outils de construction manquants, télécharge les six entrées de modèle, construit et assemble Android et toutes les images d'application, quantifie les deux modèles sources, collecte les packages micrologiciels/hôtes, crée le package hors ligne complet et exécute son programme d'installation existant. Il ne remplace pas Docker/NVIDIA, ne redémarre pas le démon Docker, n'efface pas une installation existante ou ne modifie pas le routage de l'hôte, les paramètres DNS ou VPN. Les modèles, les états de connexion des invités et le site Web de marketing privé ne proviennent pas d'une autre installation.

L'espace de travail par défaut est `/var/tmp/teamaibox-source-build` ; les caches de téléchargement et les journaux par étape se trouvent là, en dehors du clone. L'installation est par défaut `/srv/teamaibox/installation`. Attendez-vous à des téléchargements volumineux et à plusieurs centaines de Go d’utilisation temporaire du disque. Le chargement du modèle et la quantification GPU peuvent prendre un temps considérable ; aucun délai d'exécution fixe n'est promis.

## Reprise de l’installation et état

En cas d'interruption, **réexécutez exactement la même commande**. Gardez l'espace de travail. Une build en cours d'exécution exclut un autre rédacteur ; les fichiers et images de scène terminés sont vérifiés avant réutilisation. Les tentatives échouées restent disponibles pour le diagnostic, tandis que la tentative suivante exécute uniquement l'étape ayant échoué. Les plages d'octets du modèle et les fichiers vérifiés sont conservés. `state.json` identifie l'étape actuelle et son répertoire de journaux. Les téléchargements de modèles officiels utilisent la concurrence limitée fichier/plage ; les sources régionales utilisent une concurrence conservatrice pour réduire la limitation du débit. Rapports de progression des octets par fichier transférés ou plages réutilisées séparément de la vérification finale du hachage de l'éditeur. La compilation des outils invités fonctionne également sous un service système sans accès à la maison de connexion : elle crée des caches de construction isolés en dehors des actifs d'installation résultants.

Les modifications de source nécessitent un nouveau `--work-dir` ; réutilisez le cache de téléchargement avec `--cache-dir /path/to/public-cache`. L’empreinte source empêche la combinaison silencieuse des sorties de différents codes. Une installation existante n'est pas une invitation à la réinitialiser : seule l'installation du même package de cet espace de travail peut reprendre ; les autres installations doivent utiliser leur processus de mise à niveau.

Modes utiles :

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` est en lecture seule et ne prétend pas que les téléchargements réussiront. Le téléchargement uniquement et la construction uniquement ne prétendent pas explicitement être prêts à être installés.

## Sources régionales et intégrité

Le mode Chine utilise `https://hf-mirror.com` pour le transfert de modèle et `https://docker.m.daocloud.io` pour les entrées Docker Hub épinglées par résumé. Il s'agit de miroirs tiers et non de services exploités par Weerocks ou les éditeurs de modèles. Le modèle de commit Git est épinglé par le profil du produit ; son arborescence Git vérifiée et ses pointeurs LFS établissent les tailles et hachages de fichiers attendus. La réponse API du miroir ne peut à elle seule établir la confiance. Docker vérifie les résumés de manifeste/couche épinglés. Les balises non épinglées ne sont pas automatiquement redirigées (l'outil de génération Go dispose d'un verrou de résumé explicite). Les images NVIDIA restent dans le registre de leur éditeur. La vérification TLS reste activée et aucun jeton de compte n'est envoyé aux miroirs de modèles.

Vous pouvez sélectionner vos propres origines HTTPS en utilisant `--model-endpoint` and `--registry-mirror`. Les valeurs de point de terminaison ne doivent pas inclure d'informations d'identification ou de paramètres de requête. Le wrapper Docker étendu s'applique uniquement à ce processus de construction, pas au démon système ou à d'autres projets. Les métadonnées du SDK et les archives de licence proviennent toujours de leurs éditeurs HTTPS faisant autorité ; un miroir ne peut pas inventer de hachages.

Les miroirs peuvent être limités en débit ou indisponibles. Les téléchargements de modèles s'exécutent avec une concurrence limitée et respectent les temps de recharge. Aucun script ne peut garantir la connectivité à chaque amont sur chaque réseau. Si les deux itinéraires ne sont pas disponibles, préparez les téléchargements ou le package complet sur une machine compatible accessible et copiez-les sur :

- `--download-models-only --cache-dir <public-cache>` prépare les fichiers de modèle vérifiés et les caches pouvant être repris. Copiez ce répertoire, puis transmettez-le avec `--cache-dir` sur la cible. Chaque modèle réutilisé est vérifié par rapport à son identité épinglée. Ce cache n'est **pas** un package d'installation hors ligne complet.
- `--build-only` prépare le package complet pour une installation hors ligne. Copiez son tar et sa somme de contrôle, vérifiez et décompressez, puis exécutez `sudo ./install.sh` à l'intérieur. Il s'agit de la route fiable pour les hôtes déconnectés ; il ne nécessite pas de VPN sur la cible ni d'accès à un boitier de développement.

Ne copiez jamais un répertoire de données Docker en direct, des disques invités, des profils de navigateur, des bases de données de comptes, des informations d'identification ou des caches privés en remplacement des entrées publiques. Ne désactivez pas les sommes de contrôle et n'acceptez pas une page de connexion/défi comme fichier modèle.

## Licence et première utilisation

Consultez `THIRD_PARTY_NOTICES.md`, les termes du SDK Android et les licences de modèles individuels avant de créer. Le téléchargement de composants tiers ne les transforme pas en actifs MIT et n'accorde pas de droits de certification/redistribution à Google. Les supports ISO Windows/Linux sont toujours fournis par l'utilisateur. La connexion d'usine reste `admin/admin` ; changez-le avant d’exposer l’appareil. Le programme d'installation existant génère des informations d'identification de service indépendantes et signale l'état de préparation réel.

Une fois terminé, ouvrez `https://<BOX_LAN_IP>/` sur le même réseau local ; remplacez l'adresse réseau physique actuelle du Spark, et non un pont Docker ou une adresse VPN. Les enregistrements `state.json` de l'espace de travail source progressent dans la construction. Le `/srv/teamaibox/installation/readiness.json` installé enregistre les vérifications d'installation. Ni une compilation réussie ni une vérification de l'état du conteneur d'écoute ne remplacent le fonctionnement visible de bout en bout d'une application.

Le runtime de diffusion doit contenir le récepteur UxPlay, les exécutables privés de découverte D-Bus et Avahi ainsi que ses plugins multimédias. La construction finale de l'image publique vérifie ces exécutables ; une bibliothèque client à elle seule est insuffisante. Une nouvelle installation enregistre le proxy de bureau et la passerelle avec les autres dépendants de l'espace de noms réseau de l'API afin que les mises à niveau groupées de l'API puissent conserver le chemin de connexion du bureau. Ne recréez pas uniquement un sous-ensemble de ce groupe pendant la maintenance.
