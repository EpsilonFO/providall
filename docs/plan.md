# Plan : providall — appel LLM multi-provider réutilisable (Python + TypeScript)

## 1. Contexte

**Problème.** Chaque projet de Félix qui appelle un LLM réécrit sa couche d'appel (provider, clé, modèle, sortie JSON, retries). Les modèles changent tous les mois ; changer de provider est long et sans intérêt.

**Constat de l'exploration.** Cette abstraction a déjà été écrite deux fois, avec la même architecture :
- Python : `/Users/felixollivier/monumia/backend/scripts/veille_llm.py` (800 lignes). Table de fournisseurs (`FOURNISSEURS` : protocole `anthropic` | `openai_compat`, base_url, nom de clé, défauts hérités), registre de modèles (`REGISTRE` : alias → `ModelSpec` avec prix/Mtok), échappatoire `provider:model_id`, retour uniforme `LLMCall` (jamais d'exception), sorties structurées, coût + latence, table `--list-models`. Sync seulement, ni streaming ni outils. Couplé à monumia (`Aide`, `VeilleLLMOutput`, `SYSTEM`, `build_prompt`).
- TypeScript : `/Users/felixollivier/agenda/src/lib/llm/` (~1 400 lignes + 569 de tests). Format pivot chat-completions, `ProviderSpec` avec capacités, `LlmError` typée (lève), `fetch` brut sans SDK, streaming SSE, tool calling, rejeu `_raw` des blocs de raisonnement, retries, effort par rôle, `callJson(zod)` avec boucle de réparation (`planner/llm.ts`).

**Objectif.** Un dépôt `EpsilonFO/providall` contenant deux packages jumeaux (Python via uv, TypeScript via npm, tous deux installés depuis git) partageant le même modèle mental, les mêmes variables `.env` et **un seul registre de modèles**. Dans un nouveau projet : installer, poser `LLM_MODEL=…` et une clé `*_API_KEY`, appeler `complete()` / `complete_json()`.

## 2. Décisions

Prises avec l'utilisateur :
- **Langages** : Python + TypeScript dès le départ.
- **Distribution** : dépôt GitHub + installation depuis git (uv / npm), versionné par tags. Pas de PyPI ni npm registry pour l'instant (prévu en option).
- **Périmètre v1** : texte, JSON validé (Pydantic / zod) avec boucle de réparation, async, streaming, tool calling + boucle agent optionnelle, images en entrée.
- **Erreurs** : exceptions typées par défaut (`complete()`), variante sans exception (`try_complete()` / `tryComplete()`) pour les traitements en lot.

Techniques (motivées) :
- **Pas de LiteLLM / LangChain** : deux protocoles suffisent, comme le prouvent les deux implémentations existantes. Anthropic en API native (seul moyen d'avoir `output_config.format`, `output_config.effort`, raisonnement adaptatif, `stop_reason=refusal`) ; **Chat Completions** pour tous les autres (OpenAI, Gemini, xAI, Moonshot, z.ai, Mistral, DeepSeek, OpenRouter, Groq, Ollama, vLLM). L'API Responses d'OpenAI n'est pas retenue en v1 (aucun tiers ne la parle) ; un 3e protocole `openai_responses` reste possible si le smoke test « tools + reasoning_effort sur gpt-5.6 » échoue (agenda a un adaptateur de 219 lignes à porter).
- **Python : SDK officiels** `anthropic>=1` et `openai>=3` (comme monumia). **TypeScript : `fetch` brut, zéro dépendance runtime** (comme agenda), zod en peer optionnel via l'interface Standard Schema.
- **Sortie JSON** : `output_config.format` (Anthropic) / `response_format` json_schema strict ou json_object (compat) + validation Pydantic/zod côté lib + boucle de réparation (agenda) ; schéma injecté dans le system prompt quand le provider ne contraint pas (monumia `system_pour`). Jamais de préremplissage assistant (400 sur Claude 4.6+).
- **Registre partagé en données** : `registry/providers.json` + `registry/models.json` à la racine, générés dans les deux packages, avec test de parité en CI. Prix et identifiants maintenus une seule fois.
- **Une seule couche de retry**, dans la lib, identique dans les deux langages (SDK Python : `max_retries=0`) : visible dans `Response.attempts`, pas de triple timeout silencieux (rationale monumia).
- **Visibilité du dépôt** : privé par défaut (SSH marche déjà en local via `gh`). La CI de monumia fait `uv sync` : elle aura besoin d'une deploy key en lecture (`webfactory/ssh-agent`). Alternative sans friction : dépôt public (rien de secret dans le code). À trancher au moment de créer le dépôt.

## 3. Disposition du dépôt

Package TS **à la racine** (npm ne sait pas installer un sous-dossier d'un dépôt git), Python dans `python/` (uv supporte `subdirectory`). `dist/` **commité** (installation npm sans build, marche avec `npm ci --ignore-scripts`, Vercel, Docker) ; la CI vérifie qu'il est à jour.

```
providall/
├── package.json                 # "providall", type: module, files: ["dist"], bin providall
├── tsconfig.json / tsconfig.build.json / vitest.config.ts
├── src/                         # package TS (§6)
├── dist/                        # build TS commité (.gitattributes: linguist-generated -diff)
├── tests/                       # vitest, sans réseau
├── registry/
│   ├── providers.json           # source unique (§4)
│   ├── models.json
│   └── README.md                # « ajouter un modèle = une ligne »
├── scripts/
│   ├── gen-registry.mjs         # JSON → src/registry.data.ts + python/src/providall/_registry_data.py ; --check
│   └── check-version.mjs        # package.json == python/pyproject.toml == tag git
├── python/
│   ├── pyproject.toml           # name = "providall", uv_build
│   ├── src/providall/           # package Python (§6)
│   └── tests/
├── .github/workflows/ci.yml     # jobs ts + python + release-check
├── .env.example                 # commun aux deux langages
├── README.md (FR) · CHANGELOG.md · LICENSE (MIT) · .gitignore
```

## 4. Registre partagé (`registry/*.json`)

Forme des providers (fusion de `Fournisseur` monumia + `ProviderSpec` agenda) :

```json
"anthropic": {
  "protocol": "anthropic", "base_url": "https://api.anthropic.com/v1",
  "api_key_env": "ANTHROPIC_API_KEY", "aliases": ["claude"], "default_model": "claude-sonnet-5",
  "key_url": "https://console.anthropic.com/settings/keys",
  "caps": { "tools": true, "structured": "json_schema", "effort": true, "thinking": "adaptive",
            "vision": true, "temperature": false, "forced_tool_choice": true, "stream": true },
  "wire": { "max_tokens_param": "max_tokens", "effort_param": "output_config" },
  "defaults": { "max_tokens": 16000 }
}
```

- `caps.structured` est tri-état `json_schema | json_object | prompt` (leçon monumia : `json_object` garantit du JSON valide, pas conforme).
- `wire.max_tokens_param` : `max_completion_tokens` pour OpenAI (400 sinon sur les modèles à raisonnement) ; `wire.effort_param` : `output_config` (Anthropic), `reasoning_effort` (OpenAI), `openrouter_reasoning` (`extra_body.reasoning.effort`), absent ailleurs.
- Les caps non renseignées héritent des défauts du protocole.
- Providers seed : `anthropic`, `openai`, `gemini`, `xai` (alias grok), `moonshot` (alias kimi), `zai` (alias glm, OpenAI-compat `https://api.z.ai/api/paas/v4`), `zai_anthropic` (Anthropic-compat `https://api.z.ai/api/anthropic`, caps prudentes `structured: prompt`, `thinking: none` jusqu'à test), `mistral`, `deepseek` (max_tokens 32k), `openrouter` (structured prompt, effort medium mesuré, 32k), `groq`, `ollama` (`requires_key: false`), `openai_compat` (base_url via `LLM_BASE_URL`, alias compat/local/vllm/lmstudio/together/qwen).

Forme des modèles (port de `REGISTRE`) : `alias → { provider, model_id, price_in, price_out, id_verified, note, overrides: { caps, defaults, wire } }`. Prix absent = inconnu → `cost_usd = None`, jamais un faux 0. Seed : `opus` (claude-opus-5, 5/25), `sonnet` (claude-sonnet-5, **prix à vérifier** : 2/10 au lancement, monumia note 3/15 après le 2026-08-31), `haiku` (claude-haiku-4-5, 1/5, `effort: false`, `thinking: budget`), `fable` (claude-fable-5-1, 10/50, `forced_tool_choice: false`), `opus-4.8`, `sonnet-4.6`, `gpt-luna`/`gpt-terra` (id non vérifiés), `ds-flash`/`ds-pro`, `glm`/`glm-flash`, `gemini-flash`/`gemini-pro`, `grok`/`grok-fast`, `kimi-k2.7`/`kimi-k3`, `mistral`/`mistral-medium`, `or-glm`/`or-kimi`. Les identifiants tiers gardent `id_verified: false` et s'affichent « À VÉRIFIER » dans la CLI, comme monumia.

Génération : `scripts/gen-registry.mjs` (Node pur) écrit `src/registry.data.ts` (objet `as const` → types littéraux des alias) et `python/src/providall/_registry_data.py`. Mode `--check` en CI + test de parité dans chaque suite. Enregistrement à l'exécution (`register_provider`/`register_model`, `registerProvider`/`registerModel`) pour qu'un projet ajoute ses propres modèles ou notes de prix sans toucher au dépôt.

## 5. Convention `.env` (commune)

| Variable | Rôle |
|---|---|
| `LLM_MODEL` | `alias` du registre (`sonnet`, `ds-flash`) ou `provider:model_id` (`zai:glm-5.4-flash`, `openrouter:z-ai/glm-4.6`) — le seul levier obligatoire |
| `LLM_MODEL_<ROLE>` | modèle par rôle (`LLM_MODEL_PLANNER`), utilisé quand l'appel passe `role=` (agenda) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY` | une clé par provider (noms monumia conservés) |
| `LLM_BASE_URL`, `LLM_API_KEY` | serveur OpenAI-compatible quelconque (Ollama, vLLM, Groq…) ; `<PROVIDER>_BASE_URL` surcharge l'URL d'un provider connu |
| `LLM_MAX_TOKENS`, `LLM_EFFORT` (`none|low|medium|high|xhigh|max`), `LLM_TEMPERATURE`, `LLM_TIMEOUT` (secondes, défaut 600), `LLM_RETRIES` (défaut 2) | réglages globaux, surchargeables à l'appel |
| `LLM_PROVIDER` | **compat agenda** : seul → `default_model` du provider ; avec un `LLM_MODEL` nu → `LLM_PROVIDER:LLM_MODEL` |
| `LLM_DEBUG=1` | logs détaillés (corps de requête, clé masquée) |

Ordre de résolution du modèle : argument explicite > `LLM_MODEL_<ROLE>` > `LLM_MODEL` > `LLM_PROVIDER` > **une seule clé `*_API_KEY` présente → `default_model` de ce provider** (c'est ce qui rend « une clé dans `.env`, un appel » possible) > `ConfigError` listant alias et providers.

Chargement du `.env` :
- Python : rien à l'import ; au premier appel, chargement paresseux de `.env` puis `.env.local` (trouvés en remontant depuis le cwd) **sans écraser** l'environnement du process ; opt-out `PROVIDALL_NO_DOTENV=1` ; `load_env(dir)` explicite pour les apps (monumia). `python-dotenv` en dépendance dure.
- TypeScript : la lib ne lit jamais de fichier (Next.js charge `.env*` lui-même ; Node : `process.loadEnvFile()` natif). Seule la CLI charge `.env` puis `.env.local`.

## 6. API publique (miroir Python ↔ TypeScript)

Règle de nommage : objets au format « fil » (messages, `tool_calls`, `tool_call_id`, `_raw`) en snake_case dans les deux langages ; le reste snake_case en Python, camelCase en TS. Fonctions : `complete`/`complete`, `complete_json`/`completeJson`, `try_complete`/`tryComplete`, `stream`/`stream`, `tool_loop`/`toolLoop`, `resolve_model`/`resolveModel`, `list_models`/`listModels`, `Client`/`createClient`.

### Python (`python/src/providall/`)

```
__init__.py  types.py  errors.py  env.py  config.py  registry.py  _registry_data.py (généré)
schema.py  pricing.py  retry.py  client.py  structured.py  stream.py  tools.py  hooks.py
testing.py (FakeAdapter)  cli.py  providers/{base,anthropic,openai_compat}.py
```

```python
Effort = Literal["none", "low", "medium", "high", "xhigh", "max"]
Prompt = str | Sequence[Message | dict]          # str = un message user

@dataclass
class Message:      # pivot chat-completions
    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[dict] | None = None      # list = parties multimodales ({"type": "text"|"image_url"|"image_base64", ...})
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    raw: tuple[str, Any] | None = None           # (provider, blocs natifs) à rejouer — le `_raw` d'agenda

@dataclass
class Response:
    text: str; model: str; model_id: str; provider: str
    finish_reason: Literal["stop", "length", "tool_calls", "content_filter", "refusal", "pause", "other"] | None
    usage: Usage                                 # input/output/cache_read/cache_write/reasoning tokens
    latency_s: float; cost_usd: float | None; attempts: int
    tool_calls: list[ToolCall]; message: Message | None; reasoning: str | None; raw: Any
    error: ProvidallError | None = None          # renseigné uniquement par try_*
    @property ok; @property empty                # empty = EmptyResponseError retryable (le `reponse_vide` de monumia)

def complete(prompt, *, system=None, model=None, role=None, max_tokens=None, effort=None,
             temperature=None, timeout=None, tools=None, tool_choice=None, label=None) -> Response
async def acomplete(...) -> Response
def complete_json(schema: type[T], prompt, *, max_repairs=2, **kw) -> StructuredResponse[T]   # .data validé
async def acomplete_json(...)
def try_complete(...) -> Response ; def try_complete_json(...) -> StructuredResponse[T]      # ne lèvent jamais
def stream(prompt, **kw) -> Iterator[StreamEvent] ; async def astream(...)                    # TextDelta | ToolCallDelta | Done(response)
def tool_loop(prompt, *, tools: Sequence[Tool], max_turns=20, **kw) -> Response ; async def atool_loop(...)
@tool  # décorateur : schéma dérivé de la signature via pydantic.TypeAdapter

class Client:        # config réutilisable ; les fonctions module délèguent à un Client() par défaut
    def __init__(self, model=None, *, role=None, timeout=None, max_tokens=None, effort=None, temperature=None,
                 retry: RetryPolicy | None = None, api_key=None, base_url=None, on_response=None, label=None)
    # mêmes méthodes que ci-dessus + with_options(**overrides)

def resolve_model(name=None, *, role=None) -> ModelSpec ; def list_models(*, only_available=False)
def register_provider(p, *, replace=False) ; def register_model(m, *, replace=False) ; def spec(alias, provider, model_id, **overrides)
def json_schema(model: type[BaseModel]) -> dict   # durci : additionalProperties=false partout (monumia _durcir)
def load_env(directory=None) -> list[Path]
```

### TypeScript (`src/`)

```
index.ts  types.ts  errors.ts  env.ts  config.ts  registry.ts  registry.data.ts (généré)  http.ts
providers/{adapter,anthropic,chat-completions}.ts  complete.ts  json.ts  stream.ts  tools.ts  log.ts  cli.ts
```

```ts
export function complete(input: string | Message[], opts?: CompleteOptions): Promise<Response>;
export function tryComplete(input, opts?): Promise<TryResult<Response>>;        // { ok, value, error } — ne rejette jamais
export function completeJson<T>(schema: Schema<T>, input, opts?: JsonOptions): Promise<T>;   // Standard Schema : zod 4, valibot… sans importer zod
export function completeJsonResult<T>(...): Promise<{ data: T; response: Response; attempts: number }>;
export function tryCompleteJson<T>(...): Promise<TryResult<...>>;
export function stream(input, opts?): TextStream;              // AsyncIterable<string> + .response: Promise<Response> + .events
export function toolLoop(input, opts: ToolLoopOptions): Promise<ToolLoopResult>;   // tools + handlers + maxTurns
export function defineTool<T>(t: { name; description; parameters: Schema<T> | JsonSchema; handler? }): ToolDef;
export function createClient(config?: ClientConfig): Client;   // fetch/env injectables (tests)
export function resolveModel(name?, opts?: { role?; env? }): ResolvedModel;
export function listModels(env?), listProviders(), describeConfig(env?): string;   // ligne de boot, ne lève jamais

type CompleteOptions = { model?; role?; system?; maxTokens?; effort?; temperature?; tools?; toolChoice?;
                         json?; timeoutMs?; retries?; label?; signal?; fetch?; env?; logger? };
type Response = { text; message; toolCalls; reasoning?; usage; costUsd: number | null; latencyMs;
                  model; alias: string | null; provider; finishReason; raw };
```

Parties image du pivot : `{type:"image_url", url}` et `{type:"image_base64", media_type, data}` ; traduites en `image_url` (compat) ou bloc `image` (Anthropic) ; `ConfigError` si `caps.vision` est faux.

## 7. Architecture interne (identique dans les deux langages)

**Pipeline d'un appel** : résoudre le modèle → vérifier clé et capacités (outils/vision/JSON sur un provider qui ne les a pas → `ConfigError`) → normaliser le prompt (`system=` et messages `role: system` fusionnés) → `build(request)` **pur** → envoi avec retry → `parse(raw)` **pur** → coût → hook/log → `Response`. `build`/`parse` purs = testables sans réseau (généralise `kwargs_openai_compat`). Python : `send`/`asend` sont les seules lignes dupliquées sync/async (clients `Anthropic`/`AsyncAnthropic`, `OpenAI`/`AsyncOpenAI` mis en cache par clé/base_url/timeout) ; pas d'`asyncio.run()` dans les wrappers sync.

**Adaptateur Anthropic** (de `_call_anthropic` + `agenda/providers/anthropic.ts`) : `system` à part ; rôles alternés (fusion des messages consécutifs) ; messages `tool` → blocs `tool_result` groupés dans un message `user` ; rejeu verbatim des blocs natifs (`raw`/`_raw`) si même provider, sinon reconstruction texte + `tool_use` ; `output_config.format` json_schema quand `caps.structured == json_schema` ; `output_config.effort` quand `caps.effort` ; `thinking: {type: "adaptive"}` quand `caps.thinking == adaptive` (jamais `disabled`, jamais `budget_tokens` sur la famille 5) ; `temperature` seulement si `caps.temperature` ; `tool_choice: required` → `any`, sauf `forced_tool_choice: false` (Fable 5.1) → `auto` + instruction ; `stop_reason` `refusal` → `RefusalError(category, explanation)` ; texte vide → `EmptyResponseError` (non retryable si `max_tokens`) ; usage avec `cache_read`/`cache_creation`. Streaming : `messages.stream()` (Python) / SSE assemblé par index (TS, déjà écrit dans agenda).

**Adaptateur Chat Completions** (de `kwargs_openai_compat` + `agenda/providers/chat-completions.ts`) : `wire.max_tokens_param` ; `response_format` tri-état (`json_schema` strict → `json_object` + schéma injecté dans le system + mot « json » exigé par DeepSeek → rien pour `prompt`) ; `reasoning_effort` (OpenAI) ou `extra_body.reasoning.effort` (OpenRouter) ; `temperature` seulement si supportée ; assistant `content: ""` et non `null` (Mistral) ; ids d'outils fabriqués `call_{i}` s'ils manquent ; `reasoning_content` (DeepSeek) exposé dans `reasoning` ; contenu vide diagnostiqué par `finish_reason` avec les messages de monumia (`length` → « budget de sortie épuisé, modèle à raisonnement : augmenter max_tokens »), retryable seulement si inexpliqué ; usage avec `cached_tokens` et `reasoning_tokens` ; pas d'en-tête `Authorization` sans clé (serveur local). Streaming : `stream: true` + `stream_options: {include_usage: true}`, deltas `tool_calls[i].function.arguments` concaténés par index.

**Erreurs** (une hiérarchie, mêmes noms) : `ProvidallError(provider, model, retryable, request_id)` → `ConfigError` (`MissingKeyError` nomme la variable et l'URL où obtenir la clé, `UnknownModelError`, `CapabilityError`) ; `APIError(status, body)` → `AuthError` 401/403, `NotFoundError` 404 (« identifiant de modèle inconnu ? »), `BadRequestError` 400/422, `RateLimitError` 429 (`retry_after`), `ServerError` ≥ 500 (dont 529 Anthropic) ; `NetworkError` ; `LLMTimeoutError` (TS : `TimeoutError`) ; `EmptyResponseError(finish_reason)` ; `RefusalError` ; `OutputValidationError(attempts, issues, last_text)`. Python : `map_exception()` traduit les exceptions `anthropic.*` / `openai.*` (timeout testé avant connexion, car `APITimeoutError` hérite d'`APIConnectionError`). TS : `fromHttp(status, body)`.

**Retry** : `LLM_RETRIES` (défaut 2) tentatives supplémentaires, backoff linéaire 2 s × n, uniquement sur `retryable` (408/409/429/5xx, réseau, timeout, réponse vide inexpliquée). SDK Python : `max_retries=0`. `Response.attempts` rend le compte visible.

**Boucle de réparation JSON** (port de `planner/llm.ts`) : envoi → `parse_json_loose` (blocs ```json tolérés) → validation → en cas d'échec, `{assistant: brut}` + `{user: "Ta réponse ne respecte pas le format attendu :\n<issues>\nRenvoie UNIQUEMENT l'objet JSON corrigé"}` → `max_repairs` (défaut 2) → `OutputValidationError`. Issues rendues actionnables (chemin, valeurs permises, attendu).

**Boucle d'outils** (port de `ingest_aide_agent.run_agent_loop` + `agenda/agent.ts`) : table de handlers, `max_turns`, tous les `tool_result` d'un tour dans un seul message, erreur de handler renvoyée au modèle (`is_error`) par défaut, rejeu `raw` préservé, `stopped: done | max_turns`, usage et coût cumulés.

**Coût / télémétrie** : `cost_usd = in·price_in + cache_read·price_cache_read + cache_write·price_in·1.25 + out·price_out` (÷1e6), `None` si prix inconnu ; `input_tokens` normalisé « hors cache » dans les deux adaptateurs ; hook `on_response` + une ligne de log par appel (`[label] provider:model 3.2s in=… out=… cache=… $0.0041 finish=stop attempts=1`) ; jamais de `print`/`console.log` dans la lib.

## 8. CLI (`providall` dans les deux packages)

- `providall models [--available]` : port de `table_registre()` — modèle par défaut et sa source, colonnes alias · provider · id · $/Mtok in/out · clé présente · id vérifié · note, rappel des variables et de la syntaxe `provider:model_id`.
- `providall check [--model X] [--ping]` : clés présentes/absentes par provider, source de la base URL ; `--ping` envoie « Réponds uniquement : OK » (`max_tokens=16`) et affiche latence/tokens/coût ou l'erreur mappée ; code de sortie 1 en échec.
- `providall ask "prompt" [--model X] [--system S] [--json] [--effort E] [--max-tokens N] [--stream]` : texte sur stdout, tokens/coût/latence sur stderr.

## 9. Tests et CI (sans réseau)

- **Python** (pytest, `asyncio_mode=auto`) : fixture `clean_env` autouse (purge `LLM_*`, `*_API_KEY`, `*_BASE_URL`, pose `PROVIDALL_NO_DOTENV=1`) ; `test_registry` (parité avec le JSON, pas d'alias en double, héritage/surcharges, `zai:glm-5.4-flash` → id non vérifié, `openrouter:` hérite `effort=medium`) ; `test_config` (les 6 étapes de résolution, `LLM_TIMEOUT_MS` en repli, `MissingKeyError` nomme la variable) ; `test_env` (process > `.env.local` > `.env`, opt-out) ; `test_schema` (durcissement, `parse_json_loose`) ; `test_openai_compat_adapter` / `test_anthropic_adapter` (`build()` par spec : `max_completion_tokens`, `temperature` omise, tri-état `response_format`, schéma dans le system, `extra_body.reasoning` seulement OpenRouter, `output_config`, effort omis sur haiku, rejeu `raw`, `tool_choice` dégradé ; `parse()` sur des objets `ChatCompletion` / `Message` construits hors ligne : vide par `finish_reason`, `refusal`, cache tokens, ids fabriqués) ; `test_errors` (table de mapping, ordre timeout/connexion) ; `test_structured` (boucle de réparation avec `FakeAdapter`) ; `test_retry` / `test_client_try_api` (`try_complete` ne lève jamais, retry sur retryable seulement, `attempts`, hook) ; `test_cli` ; `tests/integration/test_live.py` marqué `integration`, activé par `PROVIDALL_INTEGRATION=1`, un `complete` + un `complete_json` par provider dont la clé est présente. `providall.testing.FakeAdapter` est livré pour les tests des projets consommateurs.
- **TypeScript** (vitest) : `fetch` et `env` injectés par options (helpers `fakeFetch`, `jsonRes`, `sseRes` portés de `llm.test.ts`) ; `config`, `registry` (parité), `anthropic` (corps + flux SSE, fixture REPLY d'agenda), `chat-completions`, `http` (retry 429/5xx avec timers factices et `Retry-After`, parseur SSE : chunks coupés, CRLF, `[DONE]`), `json` (les 4 cas de `callJson` + Standard Schema), `tools`, `stream`, `errors`, `cli`.
- **CI** `.github/workflows/ci.yml` (déclencheurs copiés de `/Users/felixollivier/monumia/.github/workflows/ci.yml`) : job `ts` (Node 22, `npm ci`, `gen-registry --check`, `tsc --noEmit`, vitest, build, `git diff --exit-code dist src/registry.data.ts`) ; job `python` (`astral-sh/setup-uv`, `uv sync --group dev`, `ruff check`, `ruff format --check`, `pyright`, `pytest -q`, matrice 3.12/3.13) ; job `release` sur tag `v*` : `check-version.mjs`.

## 10. Distribution et versions

Un seul tag `vX.Y.Z` versionne les deux packages (`scripts/check-version.mjs` impose `package.json` == `pyproject.toml` == tag).

Installation côté consommateur :

```bash
# Python (uv)
uv add "git+ssh://git@github.com/EpsilonFO/providall.git" --tag v0.1.0 --subdirectory python
# → [tool.uv.sources] providall = { git = "ssh://git@github.com/EpsilonFO/providall.git", tag = "v0.1.0", subdirectory = "python" }
# pip : pip install "providall @ git+ssh://git@github.com/EpsilonFO/providall.git@v0.1.0#subdirectory=python"

# TypeScript (npm)
npm install github:EpsilonFO/providall#v0.1.0          # ou "git+ssh://git@github.com/EpsilonFO/providall.git#v0.1.0"
```

Checklist de release : mettre à jour `registry/*.json` → `npm run gen` → tests des deux côtés → `npm version X.Y.Z --no-git-tag-version` + `uv version X.Y.Z` dans `python/` → `npm run build` (rafraîchit `dist/` et `registry.data.ts`) → commit `release vX.Y.Z` → `git tag vX.Y.Z && git push --follow-tags` → les consommateurs changent le tag et `uv lock --upgrade-package providall` / `npm install`.

Option ultérieure (phase 4) : `release.yml` sur tag → `uv build` + `uv publish --trusted-publishing always` (le nom `providall` est libre sur PyPI) ; npm sous `@epsilonfo/providall`.

## 11. Migration des projets existants

**monumia** (`/Users/felixollivier/monumia/backend/scripts/veille_llm.py`, 800 → ~200 lignes) : `uv add …providall --subdirectory python` (fait passer `anthropic` 0.120 → 1.x et `openai` 2.x → 3.x ; monumia ne passe aucun objet `httpx` aux SDK, donc sans risque, à confirmer par sa suite de tests). Reste dans le fichier : `SYSTEM`, `build_prompt`, `_tronquer`, constantes `MAX_CHARS_*`, imports `Aide`/`VeilleLLMOutput`, chargement `.env`/`.env.local` avec override. Remplacé par une surface de compatibilité : `LLMCall = Response`, `resoudre_modele = resolve_model`, `MODELE_DEFAUT = os.environ.get("VEILLE_MODEL") or "glm-flash"` (le levier `VEILLE_MODEL` reste), `REGISTRE`/`FOURNISSEURS` vues sur le registre, `call(spec, system, user, *, max_tokens, timeout, schema)` → `Client(spec, timeout=…, temperature=0).try_complete(user, system=system, schema=schema)`, `json_schema`, `system_pour`, `kwargs_openai_compat` (wrapper sur le `build()` de l'adaptateur pour garder `TestEffortDeRaisonnement`). Retouches mécaniques dans les consommateurs et tests : `reponse_vide` → `.empty` (`veille_update.py:181`, `veille_typage.py:599`, `veille_audit.py:953`), `LLMCall(error="…")` → `Response(error=RateLimitError(…))`, `spec.cle_presente/tarif_connu/id_verifie/prix()` → `key_present/price_known/id_verified/(price_in, price_out)`, `table_registre()` (`veille_benchmark.py:380`) → fonction exportée de la CLI. Plus tard : `ingest_aide_agent.run_agent_loop` → `tool_loop`.

**agenda** (`/Users/felixollivier/agenda`) : `package.json` ← `"providall": "github:EpsilonFO/providall#v0.1.0"` ; supprimer `src/lib/llm/{types,env,http}.ts`, `providers/*`, `llm.test.ts` (les tests migrent dans providall) ; `src/lib/llm/index.ts` devient un wrapper de ~60 lignes : réexports (`LlmMessage`, `LlmError = ProvidallError`, `AgentOutputError = OutputValidationError`, `parseJsonLoose`, `describeLlmConfig`), `MODELS` par rôle via `resolveModel(undefined, {role})`, `deliberationEffort/chatEffort/retouchEffort` (lisent `LLM_REASONING_EFFORT*` puis `LLM_EFFORT`), `llmChat(opts)` → `complete(messages, {...opts}).message`. `planner/llm.ts` devient un adaptateur de 15 lignes vers `completeJson` (`ChatFn` → `completeFn`). Sites touchés : `agent.ts:21-22, 1045-1052, 1098, 1106-1109` (`err.kind === "no-key"` → `instanceof ConfigError`, champs de `AgentOutputError`), `summary.ts`, `planner/josiane.ts`, `council.ts`, `instrumentation.ts` inchangés via le wrapper. `.env.local` : `LLM_PROVIDER=openai` continue de marcher ; forme recommandée `LLM_MODEL=gpt-terra`. Vérifier avant migration qu'un import ESM-only passe dans les route handlers Next 14 (repli : `experimental.serverComponentsExternalPackages: ["providall"]`).

## 12. Phases

| Phase | Contenu | Taille estimée |
|---|---|---|
| **0 — Squelette** | `git init`, `gh repo create EpsilonFO/providall`, arborescence §3, `package.json`/tsconfigs/vitest, `python/pyproject.toml` (`uv init --lib --build-backend uv`, ruff/pyright copiés de monumia), `registry/*.json` seed, `gen-registry.mjs`, `check-version.mjs`, `ci.yml`, `.env.example`, README (table des variables) | ½ jour |
| **1 — Cœur, les deux langages** | types, erreurs, env/config, registre, schéma, pricing, retry, adaptateurs `anthropic` + `chat-completions` (texte + JSON, sync + async), `complete`/`try_complete`/`complete_json` avec réparation, `Client`/`createClient`, hooks/log, `FakeAdapter`, CLI `models/check/ask`, suites de tests, tag **v0.1.0** | ~1 400 lignes src + ~900 tests par langage ; 2-3 jours chacun |
| **1b — Smoke test réel** (script manuel, hors CI) | `sonnet` json + tools, `gpt-terra` tools + `reasoning_effort` (tranche la question Responses), `zai`, `ds-flash`, `zai_anthropic` ; vérification des prix/ids « À VÉRIFIER » | ½ jour |
| **2 — Streaming, outils, vision** | `stream`/`astream` (+ `ask --stream`), `tool_loop`/`toolLoop` + `@tool`/`defineTool`, parties image dans les deux adaptateurs, tag **v0.2.0** | ~700 lignes par langage ; 1-2 jours chacun |
| **3 — Migrations** | monumia puis agenda (§11), leurs suites de tests au vert | 1 jour chacun |
| **4 — Options** | `openai_responses` si le smoke test l'impose, publication PyPI (trusted publishing) et npm, `release.yml` | à la demande |

Ordre conseillé : Python d'abord dans chaque phase (le SDK enlève la plomberie HTTP), TS ensuite en reprenant les mêmes fixtures de corps de requête.

## 13. Vérification de bout en bout

1. **Sans réseau** : `cd python && uv run pytest -q && uv run ruff check . && uv run pyright` ; à la racine `npm run check` (gen `--check`, tsc, vitest, build, diff `dist/`). Les deux tests de parité du registre passent.
2. **CLI** : `uv run providall models` et `npx providall models` affichent la même table ; `providall check` liste les clés présentes.
3. **Appel réel** depuis un dossier vide contenant seulement `.env` avec `ANTHROPIC_API_KEY=…` (sans `LLM_MODEL`) : `providall ask "Dis bonjour"` répond via `claude-sonnet-5` (heuristique clé unique) ; puis `LLM_MODEL=zai:glm-5.3-flash` avec `ZAI_API_KEY` → même commande, autre provider, aucun code touché. Répéter avec `--json`, `--stream`.
4. **Installation depuis git** dans un projet jetable : `uv init /tmp/essai && uv add "git+ssh://git@github.com/EpsilonFO/providall.git" --tag v0.1.0 --subdirectory python` puis `uv run python -c "import providall; print(providall.complete('ping').text)"` ; côté npm `npm install github:EpsilonFO/providall#v0.1.0` puis un script `node` de 3 lignes. Valide aussi la forme exacte des URL uv (`ssh://` vs `git+ssh://` dans le TOML).
5. **Migration** : `uv run pytest` dans `monumia/backend` et `npm test` dans `agenda` au vert ; `veille_benchmark.py --list-models` fonctionne.

## 14. Points à vérifier pendant l'implémentation

- Prix de `claude-sonnet-5` (2/10 vs 3/15 depuis le 2026-08-31) et tous les ids `id_verified: false`.
- Capacités de l'endpoint Anthropic-compatible de z.ai (`output_config`, thinking) — caps prudentes jusqu'au test.
- Tools + `reasoning_effort` sur gpt-5.6 en Chat Completions (agenda affirme que seule Responses le permet) → décide du protocole `openai_responses`.
- Acceptation de `stream_options` par les serveurs compat stricts (drapeau provider si besoin).
- Import ESM-only de `providall` dans Next 14 (agenda) avant la migration.
- Deploy key pour la CI de monumia si le dépôt reste privé.

## 15. Fichiers existants à réutiliser

- `/Users/felixollivier/monumia/backend/scripts/veille_llm.py` — `FOURNISSEURS`/`REGISTRE` → `registry/*.json` ; `kwargs_openai_compat`, `_durcir`, `system_pour`, diagnostic du contenu vide, `table_registre` ; cible de la migration.
- `/Users/felixollivier/agenda/src/lib/llm/providers/anthropic.ts` — traduction pivot ↔ Messages (system, alternance, `tool_result` groupés, assembleur SSE, rejeu `_raw`) ; remplacer `budget_tokens` par adaptive + `output_config`.
- `/Users/felixollivier/agenda/src/lib/llm/providers/chat-completions.ts` — adaptateur générique (ids fabriqués, `content: ""`, indice « json »).
- `/Users/felixollivier/agenda/src/lib/llm/http.ts` — timeout/retry/SSE → `src/http.ts` (paramétrer, SSE en générateur async).
- `/Users/felixollivier/agenda/src/lib/llm/env.ts` — ordre de résolution, rôles, normalisation de l'effort, lecture paresseuse.
- `/Users/felixollivier/agenda/src/lib/planner/llm.ts` — boucle de réparation `callJson` → `structured.py` / `json.ts`.
- `/Users/felixollivier/agenda/src/lib/llm/llm.test.ts` — helpers fake-fetch et matrice de tests à reprendre.
- `/Users/felixollivier/monumia/backend/scripts/ingest_aide_agent.py` — `run_agent_loop` → `tool_loop`.
- `/Users/felixollivier/monumia/backend/pyproject.toml`, `/Users/felixollivier/monumia/.github/workflows/ci.yml` — style ruff/pyright et gabarit CI.
- `/Users/felixollivier/monumia/backend/tests/test_veille_update.py` (et `test_veille_audit.py`, `test_veille_typage.py`) — surface de compatibilité que le shim doit préserver.
