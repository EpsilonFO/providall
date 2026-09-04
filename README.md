# providall

Un appel LLM, n'importe quel fournisseur. Deux packages jumeaux — Python et
TypeScript — qui partagent **un seul registre de modèles**, les **mêmes
variables d'environnement** et le **même modèle mental**.

```python
import providall

providall.complete("Résume ce texte en une phrase.").text
```

```ts
import { complete } from "providall";

(await complete("Résume ce texte en une phrase.")).text;
```

Dans un nouveau projet : installer, poser une clé dans `.env`, appeler. Changer
de fournisseur, c'est changer `LLM_MODEL` — pas une ligne de code.

## Pourquoi

Chaque projet qui appelle un LLM finit par réécrire la même couche : table de
fournisseurs, clés, identifiants de modèles, sortie JSON, retries, coût. Elle a
déjà été écrite deux fois ici (une fois en Python, une fois en TypeScript) avec
la même architecture. providall est cette couche, écrite une fois, avec les
leçons des deux.

Pas de LiteLLM ni de LangChain : deux protocoles suffisent. Anthropic en API
native — seul moyen d'avoir `output_config.format`, `output_config.effort`, le
raisonnement adaptatif et `stop_reason=refusal` — et **Chat Completions** pour
tous les autres (OpenAI, Gemini, xAI, Moonshot, z.ai, Mistral, DeepSeek,
OpenRouter, Groq, Ollama, vLLM).

## Installation

```bash
# Python (uv)
uv add "git+ssh://git@github.com/EpsilonFO/providall.git" --tag v0.1.0 --subdirectory python

# pip
pip install "providall @ git+ssh://git@github.com/EpsilonFO/providall.git@v0.1.0#subdirectory=python"

# TypeScript (npm) — `dist/` est commité, donc aucune étape de build
npm install github:EpsilonFO/providall#v0.1.0
```

Le package TypeScript n'a **aucune dépendance runtime** (`fetch` brut) ; zod est
un pair optionnel, atteint via l'interface Standard Schema. Le package Python
utilise les SDK officiels `anthropic>=1` et `openai>=3`.

## Configuration

Un `.env` (voir [`.env.example`](.env.example)) :

```bash
LLM_MODEL=sonnet
ANTHROPIC_API_KEY=sk-ant-…
```

| Variable | Rôle |
|---|---|
| `LLM_MODEL` | alias du registre (`sonnet`, `ds-flash`) ou `provider:model_id` (`zai:glm-5.4-flash`) — le seul levier obligatoire |
| `LLM_MODEL_<RÔLE>` | modèle par rôle, utilisé quand l'appel passe `role=` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` | une clé par fournisseur |
| `LLM_BASE_URL`, `LLM_API_KEY` | serveur OpenAI-compatible quelconque ; `<PROVIDER>_BASE_URL` surcharge un fournisseur connu |
| `LLM_MAX_TOKENS`, `LLM_EFFORT`, `LLM_TEMPERATURE`, `LLM_TIMEOUT`, `LLM_RETRIES` | réglages globaux, tous surchargeables à l'appel |
| `LLM_PROVIDER` | compat : seul → modèle par défaut du fournisseur ; avec un `LLM_MODEL` nu → `LLM_PROVIDER:LLM_MODEL` |
| `LLM_DEBUG=1` | logs détaillés |

**Ordre de résolution du modèle** : argument explicite > `LLM_MODEL_<RÔLE>` >
`LLM_MODEL` > `LLM_PROVIDER` > **une seule clé `*_API_KEY` présente → le modèle
par défaut de ce fournisseur** > erreur listant alias et fournisseurs.

C'est la dernière étape qui rend « une clé dans `.env`, un appel » possible.
Deux clés posées, et la lib redemande un `LLM_MODEL` plutôt que de choisir.

**Chargement du `.env`** — Python : rien à l'import ; au premier appel,
chargement paresseux de `.env` puis `.env.local` (trouvés en remontant depuis le
cwd) **sans écraser** l'environnement du process ; `PROVIDALL_NO_DOTENV=1` pour
couper, `load_env(dir)` pour le faire explicitement. TypeScript : la lib ne lit
**jamais** de fichier (Next.js le fait, Node a `process.loadEnvFile()`) — seule
la CLI en charge un.

## API

Même surface des deux côtés. `snake_case` en Python, `camelCase` en TypeScript,
sauf ce qui voyage sur le fil (`tool_calls`, `tool_call_id`, `image_url`).

### Texte

```python
r = providall.complete("Bonjour", system="Tu es concis.", effort="low")
r.text, r.usage.output_tokens, r.cost_usd, r.latency_s, r.attempts
```

```ts
const r = await complete("Bonjour", { system: "Tu es concis.", effort: "low" });
r.text, r.usage.outputTokens, r.costUsd, r.latencyMs, r.attempts;
```

### JSON validé, avec boucle de réparation

```python
from pydantic import BaseModel

class Fiche(BaseModel):
    nom: str
    montant: float

fiche = providall.complete_json(Fiche, prompt).data     # instance validée
```

```ts
import { z } from "zod";
const Fiche = z.object({ nom: z.string(), montant: z.number() });

const fiche = await completeJson(Fiche, prompt, {
  // Standard Schema n'expose pas de JSON Schema : le passer contraint
  // réellement le fournisseur. Sans lui, il reste la validation + réparation.
  jsonSchema: z.toJSONSchema(Fiche),
});
```

Sortie non conforme → les erreurs repartent au modèle avec la réponse fautive,
deux fois (`max_repairs` / `maxRepairs`), puis `OutputValidationError`.

### Sans exception, pour les traitements en lot

```python
r = providall.try_complete(prompt)      # ne lève JAMAIS
if not r.ok:
    escalader(r.error)
elif r.empty:                            # vide inexpliqué : rejouable
    ...
```

```ts
const r = await tryComplete(prompt);     // ne rejette JAMAIS
if (!r.ok) escalader(r.error);
```

### Streaming

```python
for evenement in providall.stream(prompt):
    if isinstance(evenement, providall.TextDelta):
        print(evenement.text, end="", flush=True)
    elif isinstance(evenement, providall.Done):
        print(evenement.response.cost_usd)
```

```ts
const flux = stream(prompt);
for await (const morceau of flux) process.stdout.write(morceau);
(await flux.response).costUsd;
```

### Outils et boucle d'agent

```python
@providall.tool
def meteo(ville: str) -> str:
    """Prévisions pour une ville."""
    return chercher(ville)

r = providall.tool_loop("Météo à Lyon ?", tools=[meteo])
r.text, r.turns, r.stopped, r.usage, r.cost_usd
```

```ts
const meteo = defineTool({
  name: "meteo",
  description: "Prévisions pour une ville",
  parameters: { type: "object", properties: { ville: { type: "string" } } },
  handler: ({ ville }) => chercher(String(ville)),
});

const r = await toolLoop("Météo à Lyon ?", { tools: [meteo] });
```

### Images

```python
providall.complete([
    {"role": "user", "content": [
        {"type": "text", "text": "Décris cette image."},
        {"type": "image_url", "url": "https://…/photo.jpg"},
    ]}
])
```

Traduites en bloc `image` (Anthropic) ou en `image_url` / data URI (compat).
`caps.vision` faux → `CapabilityError` **avant** l'envoi.

### Client réutilisable

```python
client = providall.Client("sonnet", timeout=120, effort="high", on_response=mesurer)
client.complete(prompt)
client.with_options(max_tokens=32000).complete(autre)
```

```ts
const client = createClient({ model: "sonnet", timeoutMs: 120_000, effort: "high" });
await client.complete(prompt);
```

## Erreurs

Une hiérarchie, les mêmes noms des deux côtés. `retryable` est porté par
l'erreur, pas décidé par l'appelant.

```
ProvidallError
├── ConfigError            MissingKeyError · UnknownModelError · CapabilityError
├── APIError               AuthError(401/403) · NotFoundError(404) ·
│                          BadRequestError(400/422) · RateLimitError(429) ·
│                          ServerError(≥500, dont 529)
├── NetworkError
├── LLMTimeoutError        (TimeoutError en TS)
├── EmptyResponseError     retryable seulement si le vide est inexpliqué
├── RefusalError           category, explanation
└── OutputValidationError  attempts, issues, last_text
```

`MissingKeyError` nomme la variable **et** l'URL où obtenir la clé.
`NotFoundError` rappelle qu'un 404 est presque toujours un identifiant de
modèle faux.

## CLI

Disponible dans les deux packages, sortie identique.

```bash
providall models [--available]   # table du registre : alias, id, $/Mtok, clé, id vérifié
providall check [--model X] [--ping]
providall ask "Dis bonjour" [--model X] [--json] [--stream] [--effort low]
```

`ask` écrit la réponse sur **stdout** et les métriques sur **stderr** :
`providall ask "…" > sortie.txt` ne contient que la réponse.

## Tester un projet qui utilise providall

Le double de test est livré avec la lib.

```python
from providall.testing import fake_provider, chat_reply

with fake_provider(chat_reply("bonjour")) as faux:
    assert mon_code().text == "bonjour"
    assert faux.bodies[0]["model"] == "deepseek-v4-flash"
```

```ts
import { fakeFetch, chatReply } from "providall/testing";

const faux = fakeFetch([chatReply("bonjour")]);
await monCode({ fetch: faux.fetch, env: FAUX_ENV });
expect(faux.bodies[0].model).toBe("deepseek-v4-flash");
```

Seul le transport est remplacé : `build()` et `parse()` restent ceux des vrais
adaptateurs, donc un test peut affirmer sur le corps exact qui serait parti.

## Le registre

`registry/providers.json` + `registry/models.json` à la racine, source unique
des deux packages. Ajouter un modèle = une ligne, puis `npm run gen`. Voir
[`registry/README.md`](registry/README.md).

Un modèle qui vient de sortir n'a même pas besoin d'y entrer :
`LLM_MODEL=zai:glm-5.4-flash` suffit.

Pour ajouter un modèle depuis un projet consommateur, sans toucher au dépôt :

```python
providall.register_model(providall.spec("mon-modele", "zai", "glm-5.4", price_in=0.1, price_out=0.4))
```

## Développement

```bash
npm install && npm run check          # gen --check, tsc, vitest, build, versions
cd python && uv sync --group dev
uv run pytest -q && uv run ruff check . && uv run pyright
```

Aucun test ne touche le réseau. Les appels réels vivent dans
`python/tests/integration/`, désactivés sauf `PROVIDALL_INTEGRATION=1`.

### Release

Un seul tag `vX.Y.Z` versionne les deux packages.

1. mettre à jour `registry/*.json` → `npm run gen`
2. tests des deux côtés
3. `npm version X.Y.Z --no-git-tag-version`, `uv version X.Y.Z` dans `python/`,
   et les constantes `VERSION` / `__version__`
4. `npm run build` (rafraîchit `dist/`)
5. `git commit -m "release vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags`

`scripts/check-version.mjs` impose que les cinq sources et le tag concordent.

## Licence

MIT.
