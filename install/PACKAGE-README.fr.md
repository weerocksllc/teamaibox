<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.fr.md)
<!-- doc-navigation:end -->

# Team AI Box package d'installation hors ligne

La licence pour le code original se trouve dans le `LICENSE` fourni. Les composants tiers conservent leurs licences d'origine ; voir `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT n'accorde aucun droit de redistribution supplémentaire pour les services Google, Windows, les poids de modèle ou les marques tierces. La réussite des contrôles d'intégrité des packages n'établit pas l'autorisation de redistribution pour chaque composant.

Ce package est destiné à un nouveau DGX Spark conservant un système Linux d'usine compatible. Il utilise l'environnement GPU Docker, Compose et NVIDIA existant sans les remplacer ni formater le disque système.

## Installation

Vérifiez l'archive à l'aide du fichier `.sha256` qui l'accompagne, puis extrayez-la :

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

L'installation normale ne nécessite ni accès public à Internet ni modifications manuelles des variables d'environnement. Le programme d'installation fournit les outils groupés requis, génère une configuration locale indépendante, initialise une nouvelle base de données et démarre les services. Le chargement initial du modèle peut prendre du temps ; un indicateur de chargement ne constitue pas une confirmation d’une installation réussie.

Exécutez `sudo ./install.sh --check` pour vérifier l'environnement et le package sans installer. `./install.sh --verify-package` vérifie uniquement le contenu du package et peut également s'exécuter sur le poste de travail de packaging. Utilisez `--installation-root /dedicated/path/installation` pour spécifier une nouvelle racine d'installation ; ne le dirigez jamais vers des données existantes.

## Interruptions et données existantes

Après une panne ou une interruption, résolvez le problème signalé et répétez la commande d'origine. Ne supprimez pas le répertoire d'installation. Le programme d'installation conserve l'identité et les données qu'il a générées. La réexécution d’une installation complète de la même version vérifie uniquement son état. D'autres versions utilisent le chemin de mise à niveau formel, et non l'effacement et la réinstallation. Il n’existe pas d’option d’écrasement forcé.

## Première utilisation

Ouvrez l'adresse HTTPS sur l'adresse IP actuelle de l'appliance et connectez-vous :

- Nom d'utilisateur administrateur : `admin`
- Mot de passe initial : `admin`

Le programme d'installation crée automatiquement cet administrateur ; aucune extraction de jeton de configuration ou enregistrement manuel n’est nécessaire. Le mot de passe initial est public et simple : modifiez-le dans la gestion des utilisateurs avant livraison/utilisation. Les utilisateurs ordinaires n'ont pas de compte par défaut et sont créés par l'administrateur. Cela s'applique uniquement à une base de données de comptes vide ; la reprise, la réexécution, le redémarrage et la mise à niveau ne réinitialisent jamais les comptes ou mots de passe existants aux valeurs par défaut. Le code de récupération de l'administrateur généré indépendamment est stocké sous la racine d'installation à `secrets/initial-owner-recovery.json`, lisible uniquement par la racine. N'envoyez jamais de codes de récupération aux discussions, aux tickets ou aux journaux publics. Les installations existantes ne génèrent ni ne remplacent les codes de récupération. Pour le certificat HTTPS émis localement, configurez l'approbation du navigateur conformément aux instructions de l'autorité de certification de l'administrateur. Un nom dans un certificat ne garantit pas la résolution LAN DNS/mDNS. Le certificat public de l'autorité de certification locale se trouve normalement à `/srv/teamaibox/installation/https/ca.crt`. Distribuez uniquement ce certificat public, jamais la clé privée à côté.

L'installation n'inclut pas les machines virtuelles existantes, l'état de connexion Google ou les fichiers utilisateur. Les utilisateurs téléchargent des ISO Windows/Linux ou les sélectionnent dans le lecteur d'équipe, puis installent eux-mêmes les systèmes invités. Google Play et les API externes nécessitent un accès à Internet et ne sont pas inclus dans la promesse de disponibilité hors ligne.

Les textes de licence des composants sont conservés avec leurs ressources de version. Droits d'auteur © Weerocks LLC. Contact : teamaibox@weerocks.llc.
