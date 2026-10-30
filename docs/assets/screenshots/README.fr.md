<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.fr.md)
<!-- doc-navigation:end -->

# Captures d'écran du produit public

Il s'agit de véritables captures d'atelier Team AI Box, une image claire et une image sombre pour chacun des 17 paramètres régionaux de l'interface utilisateur. Il s'agit d'actifs de documentation produit, et non de sources, de modèles ou de résultats de construction du site Web de marketing privé.

## Règles de capture

- Utiliser le langage actuel du produit et les contrôles de thème ; ne traduisez pas les étiquettes sur une capture d'écran en anglais et n'inventez pas un résultat réussi.
- Utilisez un compte de démonstration et inspectez chaque image pour détecter les messages personnels, les noms de fichiers, les informations d'identification, les codes PIN du destinataire, les adresses réseau et le chrome du navigateur. Ne publiez jamais un disque invité connecté ou une exportation de session/cookie avec des images.
- Les captures actuelles du plan de travail affichent uniquement l'état de la tâche de démonstration générique et le compte administrateur générique. Ils n’exposent pas les charges utiles des tâches.
- Conservez les paramètres du produit tels qu'ils étaient après la capture. Ne supprimez pas les données utilisateur et ne réexécutez pas les charges de travail de l'entreprise pour obtenir une capture d'écran.
- `workbench-light.jpg` and `workbench-dark.jpg` sont les originaux. La plupart utilisent la capture pleine page. L'arabe utilise la fenêtre d'affichage réelle car la capture RTL pleine page du navigateur a déplacé la page ; aucune étiquette ni aucun résultat n’a été modifié.
- Certains mots de statut de tâche en direct sont toujours en anglais dans des vues autrement localisées. Ces images préservent intentionnellement l'interface utilisateur livrée au lieu de la retoucher. Les systèmes d'exploitation invités, les réponses de modèle et les noms définis par l'utilisateur ont des paramètres de langue distincts et ne sont pas traduits par le sélecteur d'interface utilisateur.

Le moteur de rendu README nécessite les deux images pour chaque langue du produit et échoue au lieu de revenir silencieusement à une capture d'écran en anglais. Lors de l'actualisation de l'interface utilisateur, remplacez les deux thèmes et régénérez le manifeste de l'image avec `node tools/screenshot-manifest.mjs`. Conservez les identifiants de réseau/périphérique et les journaux de capture locaux hors de ce répertoire public.
