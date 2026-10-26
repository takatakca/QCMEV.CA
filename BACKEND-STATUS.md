# Reprise backend — 26 octobre 2026

Les corrections et la fusion du protocole avancé sont sauvegardées sur **`fix/backend-readiness`**. Le main actuel conserve volontairement son code antérieur : **aucun déploiement applicatif ni migration de données réelles n’a été lancé**.

Lire l’[inventaire complet de livraison](https://github.com/takatakca/QCMEV.CA/blob/fix/backend-readiness/READINESS.md) et les [preuves de vérification](https://github.com/takatakca/QCMEV.CA/blob/fix/backend-readiness/docs/verification/backend-readiness.json) avant de reprendre les anciens travaux. Base du correctif : `5bf6567`; correction du lockfile CI : `b14d580`. Branche issue du main administratif et de `feature/official-protocol-foodhub` (`903e9db`), sans perte des notes/PDF.

Résultats locaux : **203 tests unitaires, 24 tests avec PostgreSQL réel, 40+2 contrôles Food Hub**, migrations et dérive, certificats/utilisateurs, ventes/crédits/hors-ligne, reprise et limitation de connexion. Frontend Docker démarré et proxy testé; audits de production : zéro vulnérabilité connue au contrôle. La CI distante a d’abord identifié une entrée Webpack manquante sous npm 10; défaut reproduit et corrigé, nouvelle CI à consulter.

Ne pas confondre ces contrôles avec la production. Restent : dossier/signatures et accès Revenu Québec, documents/cas officiels, DEV puis ESSAI et certification, garde KMS/HSM des clés non exportables, cible/secrets de déploiement, vérification/migration des bases existantes, validation réelle du côté Food Hub et des plateformes. Construction backend Docker bloquée localement par le dépôt Alpine (403); la CI possède un job d’image dédié. Gmail et OneDrive ne sont pas accessibles à l’agent; aucun envoi ni surveillance actif.

La question sur l’existence de ventes réelles dans une base QCMEV est en attente. Préserver les données par défaut. La branche ajoute un précontrôle refusant le checksum initial incompatible : ne pas le contourner par une réinitialisation ou une suppression de volume. Aucun travail ne continue en arrière-plan après la fin de la session.

Pour reprendre : vérifier les changements locaux, récupérer la branche et continuer dessus; **ne pas refaire les corrections sur l’ancien main**. Le dossier administratif reste documenté dans `docs/revenu-quebec/REPRISE.md`.
