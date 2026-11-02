<!-- Generated from docs/readme-locales/ and docs/readme-features/fr.json by tools/render-readmes.mjs. -->
# Team AI Box — Logiciel open source pour NVIDIA DGX Spark

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**Faites de votre NVIDIA DGX Spark l’espace de travail IA de votre équipe.** Exécutez une IA locale, la génération d’images et des outils documentaires sur NVIDIA DGX Spark. Team AI Box réunit fichiers partagés, messagerie et appareils virtuels dans un espace open source accessible par navigateur.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

[Liste complète des fonctionnalités](#features) · [Installer sur un DGX Spark neuf](#install) · [Contribuez avec nous](#contribute)

## Pourquoi Team AI Box ?

- **Un espace unifié :** mêmes comptes et interface pour l'IA, la collaboration et les appareils.
- **Priorité à l’IA locale.** Exécutez l’inférence sur votre Spark et connectez des API de modèles externes si vous le souhaitez.
- **Conçu pour DGX Spark.** Installez sur Ubuntu ARM64 avec des conteneurs GPU NVIDIA et la virtualisation KVM.
- **Ouvert aux contributions :** code original MIT, 17 langues, thèmes clair/sombre et choix manuels mémorisés. L'anglais est la langue par défaut.

## Le véritable espace de travail

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/fr/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/fr/workbench-light.jpg">
  <img src="docs/assets/screenshots/fr/workbench-light.jpg" alt="Espace Team AI Box pour NVIDIA DGX Spark avec applications IA et outils d’équipe — Français" width="1280">
</picture>

[Thème clair](docs/assets/screenshots/fr/workbench-light.jpg) · [Thème sombre](docs/assets/screenshots/fr/workbench-dark.jpg)

<a id="features"></a>

## Liste complète des fonctionnalités

**Accéder à un module**

- [Espace de travail et navigation quotidienne](#feature-workspace)
- [Assistant IA et actions Agent sous contrôle](#feature-assistant)
- [Génération d’images par IA](#feature-drawing)
- [Reconnaissance et correction de texte](#feature-ocr)
- [Transcription audio enregistrée et en direct](#feature-transcription)
- [Traduction de textes, fichiers et médias](#feature-translation)
- [Messagerie d’équipe](#feature-messaging)
- [Disque d’équipe et collaboration sur les fichiers](#feature-drive)
- [Diffusion sans fil compatible AirPlay](#feature-casting)
- [Téléphones Android virtuels persistants](#feature-phones)
- [Ordinateurs virtuels Windows et Linux](#feature-computers)
- [Administration, permissions et sécurité](#feature-administration)
- [Installation depuis les sources et maintenance](#feature-installation)
- [Développement open source et extensions](#feature-developers)

<a id="feature-workspace"></a>

### Espace de travail et navigation quotidienne

- Utilisez un espace de travail unique dans le navigateur pour l’IA locale, la collaboration et les appareils virtuels sur un seul DGX Spark.
- Parcourez les applications par catégorie, recherchez dans le catalogue et ouvrez une application depuis la barre latérale.
- Consultez le chargement, la disponibilité et l’état des services de chaque application.
- Suivez les tâches en attente, en cours, terminées, échouées ou annulées dans le centre de tâches et ouvrez les résultats disponibles.
- Consultez les invitations à une diffusion en attente dans le menu des notifications et ouvrez l’application de diffusion pour y répondre.
- Choisissez parmi 17 langues d’interface, dont l’arabe avec affichage de droite à gauche. L’anglais reste la langue par défaut tant que vous n’en choisissez pas une autre.
- Choisissez une apparence claire, sombre ou conforme au système. Vos choix manuels de langue et de thème sont conservés après actualisation, reconnexion et changement d’application.

<a id="feature-assistant"></a>

### Assistant IA et actions Agent sous contrôle

- Démarrez des conversations, conservez leur historique et rouvrez les échanges précédents.
- Choisissez le mode Automatique, Réponse ou Agent pour la demande en cours.
- Joignez plusieurs fichiers à une demande et retirez des pièces jointes avant l’envoi.
- Lisez les réponses au fil de leur génération, arrêtez une exécution et reprenez son flux d’événements après reconnexion.
- Consultez les informations retournées sur le modèle, les outils, les sources et l’utilisation ; téléchargez les fichiers produits par l’exécution lorsqu’il y en a.
- Examinez la portée d’une action Agent nécessitant une confirmation, puis autorisez ou refusez cette action.
- Exécutez les travaux Agent dans un environnement isolé par utilisateur, avec un espace de travail persistant. Les outils et l’accès réseau suivent la politique de l’administrateur.

<a id="feature-drawing"></a>

### Génération d’images par IA

- Générez une image à partir d’une consigne textuelle avec le modèle d’image disponible. L’application actuelle n’est pas un éditeur de retouche ou d’inpainting.
- Choisissez une génération Automatique ou Rapide lorsque la configuration du modèle disponible le permet.
- Choisissez un format carré, paysage ou portrait, des dimensions prises en charge et une graine aléatoire ou fixe.
- Demandez une sortie PNG, WebP ou JPEG, prévisualisez le résultat et téléchargez l’image.
- Suivez la file d’attente et la génération, annulez le travail et retrouvez la tâche en cours en rouvrant la page.
- Consultez le modèle et les paramètres de génération réellement utilisés, enregistrés avec le résultat.

<a id="feature-ocr"></a>

### Reconnaissance et correction de texte

- Importez un PNG, JPEG, WebP ou PDF, ou choisissez un fichier existant dans le disque d’équipe.
- Indiquez la langue et reconnaissez du texte, des tableaux Markdown ou des formules LaTeX selon les capacités du modèle choisi.
- Examinez les résultats par page et par bloc de texte, puis corrigez manuellement le texte reconnu.
- Exportez le contenu relu au format texte, Markdown ou JSON.
- Transmettez un résultat de reconnaissance enregistré à Traduction sans réimporter ni reconnaître de nouveau la source.
- Suivez et annulez les tâches de reconnaissance. Le modèle actuel ne fournit ni coordonnées de zones ni scores de confiance.

<a id="feature-transcription"></a>

### Transcription audio enregistrée et en direct

- Choisissez un fichier audio ou vidéo local ou sur le disque d’équipe : WAV, FLAC, OGG, WebM, MP3, M4A, AIFF ou MP4.
- Prévisualisez le média source et utilisez la détection automatique de langue ou indiquez une langue prise en charge.
- Relisez les segments horodatés de la transcription et modifiez leur texte.
- Exportez du texte, du JSON ou des sous-titres SRT ou WebVTT.
- Transmettez une transcription enregistrée à Traduction et suivez ou annulez la tâche de transcription en cours.
- Transcrivez le microphone en direct lorsque HTTPS, l’autorisation du navigateur, MediaRecorder et le service temps réel sont disponibles.
- Utilisez l’horodatage par mot ou la séparation des locuteurs uniquement avec les profils compatibles. Le traitement expérimental de séparation des locuteurs nécessite une entrée WAV.

<a id="feature-translation"></a>

### Traduction de textes, fichiers et médias

- Choisissez dans le catalogue de 60 langues du modèle, détectez automatiquement la langue source ou choisissez et inversez les langues source et cible. Une qualité identique pour toutes les paires de langues n’est pas garantie.
- Traduisez du texte saisi ou collé et comparez les segments source et traduits.
- Importez une image ou un PDF, ou choisissez-le dans le disque d’équipe. Lorsque l’OCR est prêt, le texte est reconnu avant traduction.
- Traduisez les fichiers audio ou vidéo compatibles par transcription, en conservant les repères temporels des segments lorsque le service de transcription est prêt.
- Réutilisez les résultats OCR ou de transcription enregistrés et téléchargez les résultats intermédiaires disponibles.
- Modifiez le texte traduit et exportez-le en texte, Markdown ou JSON. Les résultats audio et vidéo prennent aussi en charge SRT et WebVTT.
- Suivez les étapes d’extraction, de transcription et de traduction, annulez le travail et retrouvez la tâche en cours après réouverture.
- Les langues de traduction sont distinctes de celles de l’interface, de l’OCR et de la reconnaissance vocale. La traduction de PDF porte sur le texte ; ce n’est ni une reproduction de la mise en page d’origine ni un éditeur généraliste DOCX/XLSX.

<a id="feature-messaging"></a>

### Messagerie d’équipe

- Trouvez vos collègues, démarrez des conversations individuelles et créez des groupes nommés avec les membres sélectionnés.
- Filtrez les conversations par ensemble, non lues ou groupes et recherchez les conversations et messages auxquels vous avez accès.
- Envoyez du texte et des pièces jointes ; téléchargez la version d’origine du fichier joint.
- Recevez les messages en direct, retrouvez l’historique après reconnexion, suivez les positions de lecture et voyez la présence des membres.
- Envoyez avec Entrée, insérez un saut de ligne avec Maj+Entrée et passez de la liste des conversations à la discussion sur les écrans étroits.
- Supprimez un message de votre propre vue ou effacez votre historique de discussion. Les enregistrements des autres participants ne sont pas supprimés.
- Supprimez une discussion de votre liste sans quitter le groupe. Un nouveau message peut la faire réapparaître.

<a id="feature-drive"></a>

### Disque d’équipe et collaboration sur les fichiers

- Organisez les espaces de fichiers personnels et d’équipe avec des dossiers et une navigation par fil d’Ariane.
- Passez de la liste à la grille, consultez les détails des fichiers, recherchez des fichiers ou dossiers et voyez les modifications récentes.
- Importez plusieurs fichiers, suivez la progression et annulez un transfert.
- Reprenez l’envoi multipartie d’un gros fichier en sélectionnant de nouveau le même fichier. Le serveur vérifie les parties déjà transférées.
- Créez des dossiers et renommez, déplacez ou copiez des fichiers et des dossiers.
- Prévisualisez les images, sons, vidéos, textes et PDF compatibles et téléchargez les fichiers. La lecture des médias dépend du navigateur.
- Importez une nouvelle version d’un fichier, consultez l’historique et téléchargez des versions antérieures.
- Placez des éléments dans la corbeille et restaurez-les.
- Partagez en interne avec des membres ou des équipes, avec des droits de lecture ou de modification et une expiration facultative. Il ne s’agit pas de liens publics anonymes.
- Parcourez les fichiers et dossiers partagés avec vous ; l’accès est revérifié selon les permissions et appartenances actuelles.

<a id="feature-casting"></a>

### Diffusion sans fil compatible AirPlay

- Démarrez ou arrêtez un récepteur temporaire pour les appareils Apple compatibles sur le même réseau local, avec son propre nom et son code PIN.
- Choisissez une durée de validité de 15, 30, 60 ou 120 minutes. L’arrêt ou l’expiration met fin à l’annonce du récepteur et à l’accès au visionnage.
- Réservez le visionnage à vous-même, à certains membres ou à une équipe ; les personnes invitées peuvent accepter ou refuser.
- Regardez l’écran et écoutez le son dans un navigateur. Les règles de lecture automatique peuvent nécessiter un clic pour activer le son.
- Consultez et retirez les spectateurs connectés. Un administrateur peut arrêter une session sans obtenir le droit de voir son contenu privé.
- Voyez les états de déconnexion et reconnexion ; les droits de visionnage sont revérifiés lors d’une nouvelle connexion.
- Nécessite un environnement multimédia prêt, une découverte réseau local accessible et des versions de navigateur et d’appareil compatibles. Le visionnage dans le navigateur ne fournit ni sortie HDMI, ni lecture DRM/FairPlay, ni certification Apple.

<a id="feature-phones"></a>

### Téléphones Android virtuels persistants

- Créez des téléphones Android indépendants à partir des profils système installés, en conservant les applications et données de chaque téléphone entre les sessions.
- Démarrez, éteignez, redémarrez, renommez et supprimez explicitement chaque téléphone.
- Contrôlez Android au clavier et au pointeur, ainsi qu’avec les boutons Retour, Accueil, Applications récentes et volume.
- Utilisez le son et le plein écran, reconnectez-vous ou déplacez la connexion active du téléphone vers une autre page.
- Envoyez des fichiers au téléphone et téléchargez ceux de son dossier de transfert Team AI Box.
- Installez vos propres fichiers APK après confirmation. Les permissions Android des applications ne sont pas accordées silencieusement.
- Alimentez la caméra virtuelle avec une image, une vidéo ou la caméra du navigateur lorsque cette fonction est prise en charge. Les caméras USB physiques et les entrées réseau nécessitent aussi une configuration et des autorisations administrateur.
- Autorisez temporairement le débogage ADB limité à un appareil via un relais de courte durée, avec les outils ADB standard et le client relais Node.js.
- Consultez à la demande la fréquence d’image, les pertes de paquets et le temps aller-retour de la connexion. Ces statistiques ne garantissent pas une latence de bout en bout.
- Choisissez un profil système Google Play uniquement si ses ressources sont disponibles. Cette disponibilité ne vaut ni certification Play Protect ni garantie de compatibilité avec toutes les applications Android.

<a id="feature-computers"></a>

### Ordinateurs virtuels Windows et Linux

- Créez des ordinateurs ARM64 Windows ou Linux indépendants avec les capacités CPU, mémoire et disque choisies.
- Démarrez un ordinateur, arrêtez-le normalement et supprimez un ordinateur éteint après confirmation explicite.
- Ouvrez un moniteur virtuel dans le navigateur pour voir le micrologiciel, le démarrage, l’installation et le système d’exploitation sans vous connecter d’abord au bureau à distance.
- Utilisez le clavier, le pointeur, le son, le plein écran et les commandes de reconnexion.
- Ouvrez le même ordinateur virtuel dans plusieurs onglets ou fenêtres du navigateur.
- Invitez des collègues à regarder ou contrôler un moniteur et révoquez leur accès.
- Passez le contrôle à un participant, libérez-le ou reprenez-le en tant que propriétaire ; choisissez le contrôle unique ou partagé.
- Importez un ISO d’installation avec pause, reprise et annulation, ou sélectionnez un ISO existant dans le disque personnel ou d’équipe.
- Insérez ou éjectez un support optique virtuel et choisissez un démarrage unique sur disque. Changer de support ne redémarre pas automatiquement l’ordinateur.
- Installez un système ARM64 que vous êtes autorisé à utiliser et utilisez séparément le bureau à distance facultatif. La licence Windows reste à votre charge ; aucun Windows préactivé ni support général des systèmes invités x86 n’est inclus.

<a id="feature-administration"></a>

### Administration, permissions et sécurité

- Créez des membres locaux, gérez l’état des comptes et réinitialisez les mots de passe lorsque votre rôle le permet.
- Attribuez les rôles intégrés, consultez les permissions et gérez les membres des équipes, avec des garde-fous pour les opérations concernant le propriétaire.
- Filtrez les événements d’audit par domaine ou identifiant de corrélation, consultez leurs détails et demandez une vérification d’intégrité de l’historique d’audit.
- Consultez l’état de l’appareil, des applications, du stockage et des services d’exécution depuis l’espace d’administration.
- Configurez les fournisseurs d’IA externes et leurs correspondances de modèles et d’opérations, renouvelez leurs identifiants et activez ou désactivez les fournisseurs.
- Définissez les politiques autorisées de routage local ou externe, avec accord explicite pour le traitement externe. L’IA locale ne nécessite pas de clé API externe.
- Consultez les profils de modèles installés, les versions des environnements d’exécution, leur disponibilité et les détails de validation.
- Importez des paquets de plugins vérifiés et gérez l’installation, la mise à niveau, l’activation, la désactivation et la suppression des plugins concernés. Des restrictions s’appliquent aux plugins officiels protégés.
- Consultez les files d’exécution et les tâches, ajustez les politiques de planification autorisées et annulez les travaux qui le permettent.
- Consultez les paramètres du stockage chiffré et de la protection au démarrage. Le déverrouillage automatique utilise une clé locale ; l’activation d’une phrase secrète au démarrage nécessite une vérification de récupération et une confirmation.

<a id="feature-installation"></a>

### Installation depuis les sources et maintenance

- Installez à partir d’un clone Git public avec une seule commande documentée d’installation depuis les sources sur un DGX Spark neuf et compatible.
- Préparez les outils de compilation, téléchargez les modèles et les éléments d’exécution, construisez les images applicatives, créez le paquet et installez-le en réutilisant l’environnement Docker/NVIDIA existant.
- Reprenez une préparation interrompue avec la même commande et le même répertoire de travail, en réutilisant les téléchargements vérifiés et les étapes terminées.
- Exécutez la vérification des prérequis, la préparation limitée aux téléchargements ou la création d’un paquet par compilation uniquement.
- Préparez un paquet portable complet à installer sur une cible hors ligne. La préparation depuis les sources nécessite elle-même un accès réseau.
- Vérifiez les éléments dont la version est fixée et utilisez, si nécessaire, les sources alternatives documentées ou des caches portables vérifiés. Aucun miroir tiers n’est garanti.
- Initialisez de nouveaux identifiants propres à l’appareil et le compte documenté admin/admin, puis changez son mot de passe. Ne copiez pas les comptes ou disques invités d’un autre boîtier.
- Examinez les opérations de maintenance proposées, les résultats de compatibilité, les plans d’exécution explicites et leur historique, avec des instructions de retour arrière ou de récupération ciblées ; il ne s’agit pas de mises à niveau automatiques arbitraires de l’OS ou des pilotes.

<a id="feature-developers"></a>

### Développement open source et extensions

- Consultez, modifiez et redistribuez le code original du produit et sa documentation sous licence MIT. Les composants tiers conservent leurs propres licences.
- Développez des extensions ApplicationPlugin ou ComputePlugin à l’aide des contrats du SDK public et des plugins d’exemple inclus.
- Utilisez des manifestes de paquets signés ainsi que les contrôles d’intégrité et de permissions lors de l’import de plugins. Cela ne signifie pas qu’une place de marché publique de plugins est disponible.
- Contribuez aux corrections, traductions, documents et intégrations via les issues et les pull requests. Signalez les vulnérabilités par le canal privé de sécurité.

## Qu’est-ce que NVIDIA DGX Spark ?

NVIDIA DGX Spark est un système d’IA de bureau compact équipé du superchip GB10 Grace Blackwell. La configuration 128 GB associe un CPU Arm à 20 cœurs, un GPU Blackwell et 128 GB de mémoire système unifiée, avec une bande passante de 273 GB/s. NVIDIA annonce jusqu’à 1 PFLOP de calcul IA théorique en précision FP4 avec parcimonie.

La mémoire unifiée est une mémoire système partagée, pas une VRAM dédiée. Les spécifications varient selon la configuration ; le calcul théorique ne garantit ni la vitesse des applications ni le nombre d’utilisateurs simultanés.

DGX Spark fournit le calcul. Team AI Box ajoute une interface commune pour l’inférence locale, la génération d’images, l’OCR, la transcription, la traduction et la collaboration. La première installation depuis les sources télécharge les dépendances et construit l’environnement d’exécution avant la configuration.

[Spécifications matérielles officielles de NVIDIA DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box est un projet indépendant de Weerocks LLC, et non un produit, une certification ou une recommandation de NVIDIA. Le matériel pris en charge est défini par les prérequis d’installation ci-dessous.

<a id="install"></a>

## Installer sur un DGX Spark neuf

Prévoyez un **DGX Spark vierge sous Ubuntu 24.04 ARM64**, Docker Engine/Compose v2, pilotes et conteneurs NVIDIA opérationnels, KVM, Git et Python 3.10+. Plusieurs centaines de Go temporaires sont nécessaires pour modèles, images et paquet. Ne faites pas une installation neuve sur des données existantes.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Exécutez ces commandes **sur le Spark**. Le script télécharge les entrées, construit les images, prépare un paquet hors ligne complet puis l'installe. Cette première construction nécessite Internet et du temps ; cloner ne suffit pas. Docker/NVIDIA sont réutilisés.

### Vérification et reprise

`--check` vérifie les prérequis. Après interruption, conservez `/var/tmp/teamaibox-source-build` et relancez **la même commande** : téléchargements vérifiés et étapes terminées sont réutilisés. N'effacez pas le cache et ne lancez pas de constructions concurrentes. Les sources officielles sont utilisées par défaut. En cas de blocage réseau, consultez [le guide](install/SOURCE-INSTALL.fr.md) pour les sources alternatives ou le transfert d'un cache/paquet vérifié ; aucun miroir n'est garanti. Un code modifié exige un nouveau `--work-dir`, sans contourner les contrôles.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### Après l'installation

1. Ouvrez `https://<BOX_LAN_IP>/` à l'adresse LAN actuelle et vérifiez le certificat HTTPS généré par votre appareil.
2. Connectez-vous avec `admin` / `admin`, **changez le mot de passe initial**, puis créez les comptes ordinaires. N'exposez pas ces identifiants sur Internet.
3. Attendez la disponibilité des applications et choisissez langue/thème dans le profil.
4. Fournissez vos ISO ARM64 Windows/Linux autorisées et licences. Une cible hors ligne nécessite d'abord un paquet complet : suivez [le guide du paquet](install/README.fr.md). La préparation depuis les sources est en ligne.

## Licence et limites

Le code original et la documentation sont MIT, **pas tous les binaires installés**. Composants tiers, modèles, NVIDIA, micrologiciels, Google et Windows gardent leurs conditions. Aucun poids, disque invité installé, session connectée, ISO ou paquet hors ligne n'est dans Git. La compatibilité Google n'est pas une certification Play Protect ; la diffusion ne couvre ni DRM ni certification Apple. Windows 10 ARM64 n'est pas annoncé compatible. Performances et concurrence dépendent de la charge et du matériel.

<a id="contribute"></a>

## Contribuez avec nous

Rapports de bugs, documentation, traductions, accessibilité, intégrations et code sont bienvenus. Décrivez le problème dans une issue, créez un fork et une branche ciblée, puis une PR avec contrôles et captures pertinents. Un Spark n'est pas indispensable pour la documentation ou les composants isolés ; indiquez honnêtement les validations matérielles. Ne publiez ni secrets, ni fichiers personnels, ni images connectées. Signalez les vulnérabilités en privé via SECURITY.md. Aucun CLA obligatoire ni autorisation payante.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.fr.md) · [SECURITY](SECURITY.fr.md)

## Pour aller plus loin

- [Installation depuis les sources et reprise](install/SOURCE-INSTALL.fr.md)
- [Paquet hors ligne](install/README.fr.md)
- [Environnement de développement](docs/open-source/BUILDING.fr.md)
- [Contribuer](CONTRIBUTING.fr.md)
- [Signalement privé de sécurité](SECURITY.fr.md)
- [Licences tierces et périmètre de distribution](THIRD_PARTY_NOTICES.fr.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Licences tierces et périmètre de distribution](docs/open-source/RELEASING.fr.md)
