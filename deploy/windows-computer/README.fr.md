<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.fr.md)
<!-- doc-navigation:end -->

# Exécution d'un ordinateur virtuel ARM

`Public.Dockerfile` crée la même fonctionnalité de présence physique (PPI) ARM TPM requise par le runtime `windows-arm64-ppi` d'origine. Il construit QEMU 11.1.1 à partir de la version officielle après avoir vérifié sa signature détachée par rapport à l'empreinte digitale épinglée du gestionnaire de version. Debian fournit les bibliothèques et les outils de conteneurs, pas l'exécutable QEMU utilisé pour exécuter les invités.

Ne remplacez pas cet exécutable par un ancien package de distribution QEMU. Les profils Windows activent `tpm-tis-device,...,ppi=on` ; une version sans cette propriété ARM se termine avant le démarrage du micrologiciel. La suppression de `ppi=on`, la désactivation du TPM ou la réinitialisation du TPM d'un invité ne constituent pas une réparation compatible.

La construction de l'image finale vérifie la prise en charge d'ARM TIS PPI et PulseAudio et inclut la ROM du framebuffer RAM correspondante. Sur un hôte ARM KVM, le `python3 /usr/local/bin/probe-ppi` fourni effectue une vérification QEMU/TPM en pause, sans disque. Il ne monte pas les disques invités existants et ne prouve pas que l'installation de Windows est terminée. Le démarrage de Windows doit être vérifié séparément sur un invité de test explicitement désigné.

Pour une installation existante, utilisez la politique de mise à jour d'exécution de la plateforme et le résumé de l'image de profil de l'agent de nœud correspondant. Préservez le disque, le micrologiciel, l’identité et l’état du TPM. Ne recréez pas d'invités et ne modifiez pas les images d'invités Linux en cours d'exécution simplement pour réparer le runtime Windows. Enregistrez les images créées localement comme non publiées jusqu'à ce que leurs modifications source soient validées et publiées.

Conservez la propriété de la configuration installée et les autorisations de lecture lors de sa mise à jour. Si l'API Platform est recréée pour charger la stratégie de mise à jour d'exécution, recréez également ses dépendants d'espace de noms réseau (`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` et `maintenance-controller`) à partir de leurs images inchangées. Ils doivent rejoindre l'espace de noms réseau du nouveau conteneur API. Il ne s'agit pas d'un redémarrage d'invité, de démon Docker ou de travailleur IA. Attendez que le battement de cœur authentifié normal du nœud soit rétabli avant de soumettre une opération de démarrage de Windows.
