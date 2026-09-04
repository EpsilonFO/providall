# Changelog

Un seul tag versionne les deux packages (Python et TypeScript).

## [0.1.0] — non publié

Première version. Phases 0 à 2 du plan.

### Cœur
- Deux protocoles : `anthropic` (API Messages native) et `openai_compat`
  (Chat Completions). Onze fournisseurs seed, vingt-deux modèles au registre.
- Registre partagé en données (`registry/*.json`), généré dans les deux
  packages, avec test de parité de chaque côté.
- Résolution du modèle en six étages, dont l'heuristique « une seule clé
  `*_API_KEY` présente → le modèle par défaut de ce fournisseur ».
- Échappatoire `provider:model_id` pour un modèle qui vient de sortir.
- `complete` / `try_complete` / `complete_json` (avec boucle de réparation),
  sync et async côté Python.
- Une seule couche de retry, visible dans `Response.attempts` ; SDK Python en
  `max_retries=0`.
- Coût et latence par appel ; `cost_usd` vaut `None` quand le tarif est
  inconnu, jamais un faux 0.
- Hiérarchie d'erreurs typées, identique dans les deux langages.
- `Client` / `createClient` : config réutilisable, `fetch` et `env` injectables.

### Phase 2
- Streaming (`stream` / `astream`, `TextStream` en TS), assemblé par le même
  `parse()` que le non-flux.
- Boucle d'outils (`tool_loop` / `toolLoop`), `@tool` / `defineTool`.
- Images en entrée dans les deux adaptateurs.

### Outillage
- CLI `providall models | check | ask` dans les deux packages, sortie identique.
- Doubles de test livrés : `providall.testing` (Python), `providall/testing` (TS).
- CI : ruff, pyright, pytest (3.12 et 3.13), tsc, vitest, build, `dist/` à jour,
  cohérence des versions sur tag.

### À vérifier avant de figer (§14 du plan)
- Tarif de `claude-sonnet-5` : 2/10 retenu (table Anthropic) ; monumia notait
  3/15 après le 2026-08-31.
- Tous les identifiants `id_verified: false` du registre.
- Capacités de l'endpoint Anthropic-compatible de z.ai (`output_config`,
  thinking) — caps prudentes en attendant.
- Outils + `reasoning_effort` sur gpt-5.6 en Chat Completions : décide de
  l'existence d'un troisième protocole `openai_responses`.
- Acceptation de `stream_options` par les serveurs compat stricts.
