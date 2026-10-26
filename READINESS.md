# État du backend et des intégrations — 26 octobre 2026

## Résultat et périmètre

Le backend et le tableau de bord ont été corrigés et vérifiés dans l’environnement local, avec PostgreSQL 16 et le simulateur MEV du projet. **Ce résultat ne constitue ni une certification Revenu Québec ni un déploiement réel.** Les preuves synthétiques sont dans `docs/verification/backend-readiness.json`.

La branche `fix/backend-readiness` réunit les documents administratifs de `main` et le code avancé de `feature/official-protocol-foodhub` (`903e9db`). Ne pas reprendre les anciens travaux techniques de main sans lire ce document et `HANDOFF.md`. Aucun code du dépôt Food Hub n’a été modifié par cette session.

## Corrections effectuées

| Problème confirmé | Correction |
|---|---|
| Le code avancé du protocole restait séparé du main administratif | Fusion locale des deux historiques, avec conservation des notes et des PDF |
| Deux requêtes Food Hub pouvaient réutiliser simultanément un identifiant d’événement avec des contenus différents | Relecture de l’événement gagnant après conflit d’unicité et refus du rejeu incompatible |
| Deux crédits pouvaient consulter le même solde avant leur création | Verrouillage de la vente originale et nouvelle vérification dans la transaction de création; statut original et enregistrement d’intégration atomiques |
| Un remboursement partiel pouvait excéder les taxes ou le total restant | Vérification de chaque solde TPS, TVQ et total en plus du sous-total |
| Réponse MEV vide, partielle ou ambiguë interprétée comme une acceptation | Aucun règlement de la file sans accusé associé et numéro MEV; réponse incomplète traitée comme indisponibilité, avec conservation en file et journal d’échec |
| Les numéros de transaction recommencent chaque jour et peuvent se répéter dans une file hors ligne | Division des lots avant le numéro répété; réponses non associées à une autre journée |
| La file entière était chargée avant de retenir 100 transactions | Requête ordonnée et bornée à 100 entrées |
| Processus actif interprété comme service prêt même sans base | `/api/health/ready` teste la base, renvoie 503 sans détails internes en cas de panne; contrôle Docker et runner local utilisent cette disponibilité |
| Paramètres numériques invalides pouvant désactiver les délais ou dégrader les minuteries | Validation des délais, du débit Food Hub, de la fréquence hors ligne et du port; durée JWT avec unité explicite |
| Dépendances de production avec alertes élevées / critiques | NestJS 11.2.8, Next.js 15.5.28, dépendances Multer/PostCSS corrigées; audits de production sans vulnérabilité connue au moment du contrôle |
| Le proxy Next utilisait une variable de construction comme si elle était modifiable au démarrage | `API_INTERNAL_URL` passé au build; seules les routes du personnel et les sondes prévues sont exposées |
| Les dépendances / secrets locaux pouvaient entrer dans le contexte Docker | `.dockerignore` par composant |
| Le conteneur frontend quittait avec EACCES sur `/app/package.json` | Copie avec propriété `node:node`; démarrage effectif contrôlé sans utilisateur root |
| Les builds proxifiés nécessitent l’autorité TLS de la session | Secret BuildKit `proxy_ca` optionnel; vérification TLS et signatures de paquets maintenues; aucune CA de session conservée dans les couches |
| Ancien schéma initial incompatible avec le schéma de la branche protocole | `db:preflight` vérifie le checksum avant migration; refuse une base héritée incompatible sans réinitialiser ni rebaseliner les données |
| Totaux financiers du jour incluant les taxes des additions et estimations | Totaux limités aux reçus de fermeture et notes de crédit RFER; cas réel DB vérifié |
| Aperçu de facture différent du calcul en cents du backend | Arrondis des lignes puis des bases de taxes alignés et comparés au calcul réel du backend; option de paiement MOBILE non prise en charge retirée, modes chèque et mixte proposés |
| Journal du runner susceptible d’afficher l’URL avec mot de passe temporaire | URL masquée dans la commande affichée; secrets de test conservés hors dépôt puis supprimés |

## Résultats mesurés le 26 octobre

- **203 tests unitaires passés**; les 25 tests de base sont ignorés par cette commande puis exécutés séparément.
- **24/25 tests avec PostgreSQL passés**, dont concurrence, changement de journée et protection de l’ancien schéma.
- **40/40 contrôles Food Hub, puis 2/2 après redémarrage**, scénarios internes et limitation de connexion passés.
- Typage, lint et builds backend/frontend passés. Audits des dépendances de production : **0 vulnérabilité connue** pour chaque composant.
- Installation reproductible exécutée avec les lockfiles; la première CI Node 22/npm 10 a ensuite identifié une entrée Webpack manquante, non détectée par npm 11 local. Lockfile réparé avec npm 10.9.9 et installation gelée simulée avec succès dans Node 22. **CI complète réussie sur `23824ed` : [run 40410849048](https://github.com/takatakca/QCMEV.CA/actions/runs/40410849048)**, dont backend, frontend, e2e-simulator, frontend-container et backend-image. Le dernier correctif des totaux journaliers est inclus.

## Vérifications et portée

- Compilation, typage et lint backend; tests unitaires.
- PostgreSQL réel embarqué, précontrôle de migration, migrations et contrôle de dérive.
- Suite d’intégration du projet : certificats AJO/REM, UTL, ventes, formation, crédits, correction, signature et chaîne d’audit, tenant isolation, certificat expiré, validation des payloads et reprise hors ligne.
- Nouveaux cas avec base : crédits simultanés malgré un précontrôle périmé; deux journées avec le même numéro dans la file; refus d’un checksum hérité et conservation de la base après rollback.
- Scénarios internes et contrat Food Hub : rejeu, conflits, montants, QR, indisponibilité, erreurs, reprise après redémarrage et limitation de connexion.
- Compilation Next, typage/lint, construction Docker frontend, démarrage réel du conteneur et transport HTTP vers un **backend de test déterministe**. Ce dernier contrôle vérifie le routage et les permissions, pas le protocole fiscal réel.
- Configurations Compose standard et développement syntaxiquement validées avec un fichier de secrets jetables hors dépôt. **La pile Compose complète n’a pas été exécutée.**
- CI complétée par un test de démarrage du conteneur frontend et la construction de l’image backend. Une définition CI n’est pas une exécution CI réussie; vérifier les résultats distants séparément.

## Bloquants pour la production — ne pas les déclarer terminés

1. **Dossier partenaire Revenu Québec et signatures.** SW-10 corrigé, résolution électronique préparée. Aucun courriel envoyé dans cette session; résolution encore sans signature des administrateurs. Détails : `docs/revenu-quebec/REPRISE.md`.
2. **Documentation et accès officiels.** Identifiants développeur, URL DEV/ESSAI, documents SW-73 / A / B / D et cas SW-77 personnalisés non fournis à cette session. Les formats provisoires sont inventoriés dans `SPEC_GAPS.md` (32 entrées), pas validés par notre simulateur.
3. **Exécution réelle DEV puis ESSAI et certification.** Aucun test effectué sur les systèmes Revenu Québec. Aucun numéro de certification confirmé. PROD reste refusé par le code.
4. **Clés privées non exportables.** Le backend utilise encore des clés logicielles chiffrées. Le fournisseur et l’implémentation KMS/HSM manquent; ce n’est pas corrigé par un simple ajout de secret ou un certificat numérique PDF.
5. **Cible de déploiement et secrets persistants.** Aucun accès Coolify/serveur, DNS, base de production ou compte d’infrastructure n’est configuré dans la session. JWT, clé de chiffrement, sauvegarde/restauration et rotation des secrets doivent être configurés pour la cible choisie; les secrets jetables du runner ne sont pas des secrets de production.
6. **Base existante.** L’ancien init main et celui du protocole sont incompatibles. Le précontrôle arrête le déploiement si le checksum ne correspond pas. Si des données existent, un plan de migration testé avec sauvegarde/restauration est nécessaire. **Ne pas utiliser `down -v`, `migrate reset` ou `migrate resolve` pour contourner ce blocage.** L’utilisateur a été interrogé; en l’absence de réponse, préserver toute donnée existante.
7. **Reconstruction backend dans ce cloud.** L’essai de build échoue sur HTTP 403 au dépôt Alpine, et non parce qu’OpenSSL ou tini n’existent pas. Les domaines `dl-cdn.alpinelinux.org` et `binaries.prisma.sh` sont ajoutés au brouillon réseau, pas prouvés appliqués. La génération Prisma et le parcours natif ont ensuite réussi dans l’instance actuelle; l’installation normale a ensuite été réexécutée avec succès. La CI GitHub `40410849048` a également construit l’image backend avec succès; le refus local Alpine reste distinct de cette preuve distante.
8. **Food Hub réel.** Le contrat du côté QCMEV passe localement, mais le déploiement du dépôt `takatakca/foodhubca`, le secret partagé, les mappings réels et une commande réelle de chaque plateforme ne sont pas vérifiés. Inspection en lecture seule de sa branche `feature/mev-qcmev-integration` à `74d1762` : le mock et deux attentes E2E gardent l’ancien format de numéro et la référence sous forme de mention. Son journal nécessite une reprise sur sa branche/PR existante; l’API GitHub des PR est inaccessible ici. Ne pas annoncer la PR #99 fusionnée ou les plateformes réelles validées.
9. **Gmail / OneDrive.** L’autorisation de suivi administratif est donnée, mais aucun outil Gmail/OneDrive n’est exposé. Aucun envoi, dépôt ou service permanent de surveillance n’est actif. Voir `docs/revenu-quebec/ENVOI-ET-SUIVI.md`.

## Fonctions hors du périmètre actuellement terminé

Ces fonctions restent non construites ou partielles; ne pas les vendre comme offertes : révocation distante CRT SUP (la révocation actuelle est locale), workflows ANN/PSP, paiements par versements / montant dû, transfert ou regroupement de factures et d’items, taxe supplémentaire, lecture de QR, codes de fidélité/coupons/porté au compte, parcours de tables/bar avancés et envoi du rapport utilisateur par courriel/SMS. Les précisions et certains formats attendent aussi les documents partenaires. Le mode serveur distant et le SEV autonome ne sont pas offerts. Inventaire fonctionnel détaillé : `CERTIFICATION.md`.

## Reproduire les contrôles

Node 22 recommandé (CI et Docker); le parcours natif de cette session utilise Node 24.19.0. Depuis la racine :

```sh
npm --prefix backend ci --cache /tmp/qcmev-npm-cache
npm --prefix backend run prisma:generate
npm --prefix backend run typecheck
npm --prefix backend run lint
npm --prefix frontend ci --cache /tmp/qcmev-npm-cache
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix tools/local-run ci --cache /tmp/qcmev-npm-cache
node tools/local-run/run-local.mjs
```

Le runner crée une base **neuve jetable** et des identités de test. Il teste, démarre/redémarre ses propres processus puis les arrête. `--keep` conserve ses fichiers dans le dossier temporaire annoncé (secrets de test compris); ne pas les committer.

Docker frontend, avec proxy CA si le cloud en fournit une :

```sh
BUILDX_CONFIG=/tmp/qcmev-buildx docker build \
  --secret "id=proxy_ca,src=$CODEX_PROXY_CERT" \
  --build-arg API_INTERNAL_URL=http://qcmev-backend:3001 \
  -t qcmev-frontend:readiness frontend
python3 scripts/verify-frontend-container.py
```

Hors cloud avec confiance TLS normale, omettre `--secret`. Garder les identifiants Docker existants; ne pas désactiver TLS. Le script de contrôle utilise seulement ses propres conteneurs et réseaux jetables. Une installation réelle doit exécuter le précontrôle de base avant `prisma migrate deploy` et conserver une clé de chiffrement persistante.
