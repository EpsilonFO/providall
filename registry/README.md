# Le registre

Deux fichiers JSON, source unique pour les deux packages.

```
providers.json   protocole, adresse, nom de clé, écarts au protocole
models.json      alias → identifiant, tarif, surcharges
```

`npm run gen` en dérive `src/registry.data.ts` et
`python/src/providall/_registry_data.py`. **Ne jamais éditer ces deux-là** : la
CI les régénère et compare (`node scripts/gen-registry.mjs --check`), et chaque
suite de tests a un test de parité avec le JSON.

## Ajouter un modèle = une ligne

```json
"glm-5.4": {
  "provider": "zai",
  "model_id": "glm-5.4-flash",
  "price_in": 0.10,
  "price_out": 0.40,
  "id_verified": false,
  "note": "annoncé le 2026-09-01, id à confirmer"
}
```

Puis `npm run gen`. C'est tout : les deux packages le connaissent.

En attendant même ça, `LLM_MODEL=zai:glm-5.4-flash` marche déjà — protocole,
URL et nom de clé viennent du fournisseur, l'identifiant est pris tel quel, le
tarif reste inconnu. C'est l'échappatoire qui fait qu'un modèle sorti ce matin
est utilisable ce matin.

## Les trois règles qui comptent

**Un tarif absent veut dire « inconnu », pas « gratuit ».** Omettre `price_in`
/ `price_out` donne `cost_usd = null`. Écrire `0` est refusé par le générateur :
un faux zéro se retrouve additionné dans un rapport de benchmark sans que
personne ne le voie. `price_cache_read` vaut par défaut `price_in / 10`. Seule
exception : `price_out: 0` d'un modèle System One, dont la sortie n'est
réellement pas facturée.

**`id_verified: false` par défaut pour un identifiant recopié d'une annonce.**
La CLI l'affiche « À VÉRIFIER ». On le passe à `true` quand un appel réel a
abouti (`tests/integration/test_live.py`).

**N'écrire que les ÉCARTS.** Ce qui n'est pas déclaré est hérité :

```
protocole  (PROTOCOL_DEFAULTS, dans registry.py / registry.ts)
   ↓
provider   (providers.json)
   ↓
modèle     (models.json, clé `overrides`)
```

Recopier une valeur qui vaut déjà le défaut, c'est garantir qu'elle ne suivra
pas la prochaine correction du protocole.

## Deux familles

`protocol` range un fournisseur dans une famille :

| Protocole | Famille | Point d'entrée |
|---|---|---|
| `anthropic`, `openai_compat` | chat | `complete()`, `stream()`, `tool_loop()`, `complete_json()` |
| `systemone` | décision (System One) | `decide()` seulement |

Chaque famille a sa résolution (`LLM_MODEL` pour le chat, `LLM_MODEL_DECIDE`
pour la décision) et sa règle « une seule clé présente ». Un même fournisseur
qui sert les deux familles s'inscrit deux fois, une par protocole, avec la même
clé : `openrouter` et `openrouter_systemone` partagent `OPENROUTER_API_KEY`,
comme `zai` et `zai_anthropic` partagent `ZAI_API_KEY`.

Les `caps` du protocole `systemone` sont toutes fausses : elles ne servent
qu'à ce qu'un `complete()` égaré échoue proprement.

## Champs

### `caps` — ce que le modèle sait faire

| Cap | Valeurs | Effet |
|---|---|---|
| `tools` | bool | `tools=` sur un modèle sans → `CapabilityError` avant l'envoi |
| `structured` | `json_schema` \| `json_object` \| `prompt` | tri-état : `json_object` garantit du JSON valide, PAS conforme ; `prompt` = rien sur le fil |
| `effort` | bool | faux → le paramètre d'effort est omis (il *errore* sur Haiku 4.5) |
| `thinking` | `adaptive` \| `budget` \| `none` | `adaptive` pour la famille Claude 5 ; `budget_tokens` y répond 400 |
| `vision` | bool | faux → une partie image lève `CapabilityError` |
| `temperature` | bool | faux → `temperature` omise (400 sur Sonnet 5 / Opus 5 / OpenAI raisonnant) |
| `forced_tool_choice` | bool | faux → `tool_choice: required` dégradé en `auto` + instruction (Fable 5.1) |
| `stream` | bool | |

### `wire` — détails de protocole

| Clé | Exemple | Pourquoi |
|---|---|---|
| `max_tokens_param` | `max_completion_tokens` | OpenAI a renommé le champ et répond 400 sur l'ancien |
| `effort_param` | `output_config` / `reasoning_effort` / `openrouter_reasoning` | trois façons de dire la même chose |
| `effort_values` | `["low","medium","high"]` | échelle acceptée ; une valeur hors échelle est **ramenée**, jamais rejetée |

### `defaults`

`max_tokens` (les modèles à raisonnement brûlent leur budget en chaîne de
pensée avant d'écrire : DeepSeek et OpenRouter sont à 32 k) et `effort`
(OpenRouter à `medium`, mesuré — sans réglage, 405 s par appel).

## Après modification

```bash
npm run gen
npm test                        # test de parité TS
cd python && uv run pytest -q   # test de parité Python
npx providall models            # relecture visuelle
```
