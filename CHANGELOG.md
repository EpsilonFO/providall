# Changelog

Un seul tag versionne les deux packages (Python et TypeScript).

## [Non publié]

### Famille System One : `decide()`

Les modèles de décision ne produisent pas de texte : un `state` et des
questions typées en entrée, des probabilités calibrées en sortie. Ils ont
désormais leur famille, à côté du chat, plutôt que d'être tordus dans
`complete()`.

- Troisième protocole, `systemone` (`POST …/v1/systemone`), et deux
  fournisseurs qui le parlent à l'identique : `typesafe` (`TYPESAFE_API_KEY`)
  et `openrouter_systemone` (`OPENROUTER_API_KEY`, même clé que le chat
  d'OpenRouter). Trois modèles : `jev` (`jev-latest`), `jev-1.13` (épinglé),
  `or-jev` (`typesafe/jev-1.13`).
- `decide()` / `tryDecide()` en TypeScript ; `decide()` / `adecide()` /
  `try_decide()` / `atry_decide()` en Python. Fabriques `noul()`, `choice()`,
  `score()` ; en TypeScript, les options d'un `choice` typent la réponse.
- `Decision` : réponses typées, `servedModel` / `served_model` (la version qui
  a répondu, à journaliser avec les seuils de confiance), `requestId`, usage,
  coût, latence, tentatives.
- Coût : celui facturé (`usage.cost` d'OpenRouter) quand il est rendu, sinon le
  tarif du registre. `price_out: 0` est désormais accepté par le générateur,
  pour un modèle System One seulement.
- Résolution par famille : `LLM_MODEL_DECIDE`, puis `LLM_MODEL` s'il désigne un
  modèle System One, puis « une seule clé System One présente ». Une clé
  TypeSafe ne devient jamais le défaut de `complete()` ; `complete()` sur Jev et
  `decide()` sur un modèle de chat lèvent `CapabilityError` avant l'envoi.
- `LLM_API_KEY` et `LLM_BASE_URL` (serveur de chat compatible) ne sont plus
  appliqués à un fournisseur System One : ils auraient envoyé la requête, ou la
  clé, au mauvais service.
- Base `…/v1` ou racine nue (convention des SDK TypeSafe,
  `TYPESAFE_BASE_URL=https://openrouter.ai/api`) : les deux mènent au bon
  endpoint.
- Hooks `on_decision` / `onDecision`, ligne de log dédiée, double de test
  `decision_reply` / `decisionReply`.
- Python : `httpx2` devient une dépendance déclarée (les SDK Anthropic et OpenAI
  la tiraient déjà).

### Divers

- Un 422 de validation (`detail: [{loc, msg}]`) donne un message qui nomme
  chaque champ fautif.
- `format_cost` / `formatCost` : deux chiffres significatifs sous 0,0001 $ —
  une décision coûte ~0,00001 $, et « $0.0000 » ne disait rien.
- `providall models` : colonne `provider` élargie, rappel de
  `LLM_MODEL_DECIDE`.

## [0.3.1]

### Python : deux paramètres que le SDK refusait avant l'envoi

Les adaptateurs Python passent le corps au SDK par `create(**body)` : une clé
qui n'est pas un argument nommé lève un `TypeError` avant tout envoi. Les tests
de `build()` ne le voyaient pas, puisqu'ils ne regardent que le dictionnaire.
TypeScript n'est pas concerné : son corps part tel quel par `fetch`.

- DeepSeek, `effort="none"` : `thinking: {type: disabled}` passe désormais par
  `extra_body`. Depuis la 0.2.0, couper le raisonnement de DeepSeek en Python
  échouait systématiquement.
- Anthropic : le SDK 1.x a retiré `temperature` de la signature de
  `messages.create()`. La température (Haiku 4.5, Sonnet 4.6) passe donc elle
  aussi par `extra_body`. L'API l'accepte toujours.
- Nouveau test `test_sdk_signatures.py` : pour chaque modèle du registre, chaque
  effort et les options qui ajoutent des clés, le corps ne doit porter que des
  arguments du SDK qui l'envoie.

## [0.3.0]

### `extra_body` : les paramètres que providall ne modélise pas

- Nouvelle option d'appel et de client : `extra_body=` (Python) / `extraBody`
  (TypeScript). Ses clés sont ajoutées au corps de la requête **après** tout ce
  que la lib a construit, et l'emportent en cas de conflit. C'est l'échappatoire
  pour un paramètre propre à un fournisseur : `prompt_cache_key` chez Mistral
  (sans lui, aucun cache de préfixe), un réglage de sécurité, un paramètre sorti
  ce matin. `Request.extra` existait côté Python mais aucun adaptateur ne le
  lisait : c'est lui qui porte l'option désormais.
- Python : passé au SDK par `extra_body`, qu'il fusionne au premier niveau du
  JSON. Sur le fil, le résultat est identique à TypeScript, où les clés sont
  posées directement dans le corps. Chez OpenRouter, l'effort déjà placé dans
  `extra_body` est conservé.
- Celui de l'appel **remplace** celui du client, il ne s'y ajoute pas (même
  règle que les autres options de `createClient`).

### Mistral Small 4

- Alias `mistral-small` → `mistral-small-2603`, tarif 0,15 / 0,60 $ par million
  de jetons. Le modèle raisonne : `caps.effort` et `reasoning_effort` sur
  l'échelle `none|high`, donc `effort: "none"` coupe la chaîne de pensée.
  `id_verified: false` tant qu'un appel réel n'a pas abouti.

## [0.2.0]

### DeepSeek : piloter le raisonnement de V4

- L'entrée `deepseek` du registre déclare enfin son paramètre d'effort :
  `reasoning_effort` sur l'échelle `low|high|max`. Jusqu'ici elle héritait
  d'`openai_compat` (`effort_param: null`), donc tout `effort` passé à
  `complete()` était jeté avant l'envoi et V4 restait sur son défaut —
  thinking activé, effort `high`.
- `caps.temperature: false` chez DeepSeek : en mode thinking, l'API refuse
  `temperature`, `top_p`, `presence_penalty` et `frequency_penalty`.
- Nouvelle clé de wire `thinking_toggle` (`Wire.thinkingToggle` /
  `Wire.thinking_toggle`). `reasoning_effort` ne descend pas sous `low` :
  `effort: "none"` chez DeepSeek envoie donc `thinking: { type: "disabled" }`
  et coupe la chaîne de pensée, au lieu d'être ramené à `low`. C'est ce qui
  permet à un appel de routage d'outils de dire « ne réfléchis pas ».
- `medium` et `xhigh` restent ramenés à la valeur la plus proche de l'échelle
  DeepSeek par `clampEffort` / `clamp_effort`, comme chez OpenAI.

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
