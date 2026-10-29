# Reprise du projet


## 🧭 Agent board: read FIRST (owner's order 2026-10-28)

All agents, wherever they run (Claude Code desktop or cloud, claude.ai, Cursor, subagents), coordinate on **one pinned public issue**: https://github.com/takatakca/foodhubca/issues/105
1. **Before any job,** read its latest comments. A job claimed or updated there in the last 24 h belongs to that agent: continue from its next step, or pick another job.
2. **Post** `CLAIM`, then `UPDATE` about every 20 minutes and before long steps, then `PAUSED` or `DONE` when you stop. If a usage limit is near, post `PAUSED` with the exact next step **before** a long step.
3. **One line per comment:** `STATUS | agent: <name> @ <where it runs> | repo · branch → PR | job | next step`.
4. **The board is public:** no secrets, codes, signatures, personal or tax data. Notes in `WORKLOG.md` / `HANDOFF.md` / `private/` still apply. The board is what agents in *other* environments can see.

Lire `BACKEND-STATUS.md` et `HANDOFF.md` avant de modifier le backend. Les corrections avancées et les preuves de validation sont sur la branche `fix/backend-readiness`; poursuivre ce travail sans le refaire sur l’ancien main. Lire son `READINESS.md` pour les fonctions manquantes et les conditions de déploiement encore non satisfaites.
