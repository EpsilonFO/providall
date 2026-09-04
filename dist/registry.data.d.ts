/**
 * GÉNÉRÉ PAR scripts/gen-registry.mjs — NE PAS ÉDITER À LA MAIN.
 *
 * Source : registry/providers.json et registry/models.json.
 * Régénérer : npm run gen (ou node scripts/gen-registry.mjs).
 */
export declare const PROVIDERS_DATA: {
    readonly anthropic: {
        readonly protocol: "anthropic";
        readonly base_url: "https://api.anthropic.com/v1";
        readonly api_key_env: "ANTHROPIC_API_KEY";
        readonly aliases: readonly ["claude"];
        readonly default_model: "claude-sonnet-5";
        readonly key_url: "https://console.anthropic.com/settings/keys";
        readonly note: "API Messages native : seule à exposer output_config.format, output_config.effort et le raisonnement adaptatif";
    };
    readonly openai: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://api.openai.com/v1";
        readonly api_key_env: "OPENAI_API_KEY";
        readonly aliases: readonly ["gpt", "chatgpt"];
        readonly default_model: "gpt-5.6-terra";
        readonly key_url: "https://platform.openai.com/api-keys";
        readonly caps: {
            readonly structured: "json_schema";
            readonly effort: true;
            readonly temperature: false;
        };
        readonly wire: {
            readonly max_tokens_param: "max_completion_tokens";
            readonly effort_param: "reasoning_effort";
            readonly effort_values: readonly ["none", "low", "medium", "high"];
        };
        readonly note: "modèles à raisonnement : max_completion_tokens (400 sur max_tokens), temperature non par défaut refusée";
    };
    readonly gemini: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://generativelanguage.googleapis.com/v1beta/openai/";
        readonly api_key_env: "GEMINI_API_KEY";
        readonly aliases: readonly ["google"];
        readonly default_model: "gemini-3-flash";
        readonly key_url: "https://aistudio.google.com/apikey";
        readonly caps: {
            readonly structured: "json_schema";
        };
    };
    readonly xai: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://api.x.ai/v1";
        readonly api_key_env: "XAI_API_KEY";
        readonly aliases: readonly ["grok"];
        readonly default_model: "grok-4";
        readonly key_url: "https://console.x.ai";
    };
    readonly moonshot: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://api.moonshot.ai/v1";
        readonly api_key_env: "MOONSHOT_API_KEY";
        readonly aliases: readonly ["kimi"];
        readonly default_model: "kimi-k2.7";
        readonly key_url: "https://platform.moonshot.ai/console/api-keys";
    };
    readonly zai: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://api.z.ai/api/paas/v4";
        readonly api_key_env: "ZAI_API_KEY";
        readonly aliases: readonly ["glm", "z"];
        readonly default_model: "glm-5.3-flash";
        readonly key_url: "https://z.ai/manage-apikey/apikey-list";
    };
    readonly zai_anthropic: {
        readonly protocol: "anthropic";
        readonly base_url: "https://api.z.ai/api/anthropic";
        readonly api_key_env: "ZAI_API_KEY";
        readonly aliases: readonly ["glm-anthropic"];
        readonly default_model: "glm-5.3";
        readonly key_url: "https://z.ai/manage-apikey/apikey-list";
        readonly caps: {
            readonly structured: "prompt";
            readonly thinking: "none";
            readonly effort: false;
        };
        readonly note: "endpoint Anthropic-compatible de z.ai : caps prudentes (output_config non testé) — cf. §14 du plan";
    };
    readonly mistral: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://api.mistral.ai/v1";
        readonly api_key_env: "MISTRAL_API_KEY";
        readonly aliases: readonly ["mistralai"];
        readonly default_model: "mistral-large-latest";
        readonly key_url: "https://console.mistral.ai/api-keys";
    };
    readonly deepseek: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://api.deepseek.com";
        readonly api_key_env: "DEEPSEEK_API_KEY";
        readonly aliases: readonly ["ds"];
        readonly default_model: "deepseek-v4-flash";
        readonly key_url: "https://platform.deepseek.com/api_keys";
        readonly defaults: {
            readonly max_tokens: 32000;
        };
        readonly note: "mesuré : 8 000 jetons de reasoning_content avant d'écrire, d'où le budget doublé";
    };
    readonly openrouter: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://openrouter.ai/api/v1";
        readonly api_key_env: "OPENROUTER_API_KEY";
        readonly aliases: readonly ["or"];
        readonly default_model: "z-ai/glm-5.3-flash";
        readonly key_url: "https://openrouter.ai/settings/keys";
        readonly caps: {
            readonly structured: "prompt";
            readonly effort: true;
        };
        readonly wire: {
            readonly effort_param: "openrouter_reasoning";
            readonly effort_values: readonly ["low", "medium", "high"];
        };
        readonly defaults: {
            readonly max_tokens: 32000;
            readonly effort: "medium";
        };
        readonly note: "passerelle : identifiant préfixé de l'éditeur, tarif propre à chaque modèle ; response_format transmis tel quel au modèle routé (400 s'il ne le connaît pas) ; effort medium mesuré le 2026-09-01";
    };
    readonly groq: {
        readonly protocol: "openai_compat";
        readonly base_url: "https://api.groq.com/openai/v1";
        readonly api_key_env: "GROQ_API_KEY";
        readonly aliases: readonly [];
        readonly default_model: "llama-3.3-70b-versatile";
        readonly key_url: "https://console.groq.com/keys";
        readonly caps: {
            readonly structured: "json_schema";
        };
    };
    readonly ollama: {
        readonly protocol: "openai_compat";
        readonly base_url: "http://localhost:11434/v1";
        readonly api_key_env: "OLLAMA_API_KEY";
        readonly aliases: readonly [];
        readonly default_model: "";
        readonly requires_key: false;
        readonly caps: {
            readonly vision: false;
        };
        readonly note: "serveur local : aucune clé, aucun en-tête Authorization";
    };
    readonly openai_compat: {
        readonly protocol: "openai_compat";
        readonly base_url: "";
        readonly api_key_env: "LLM_API_KEY";
        readonly aliases: readonly ["compat", "custom", "local", "vllm", "lmstudio", "together", "qwen"];
        readonly default_model: "";
        readonly requires_key: false;
        readonly caps: {
            readonly vision: false;
        };
        readonly note: "n'importe quel serveur /chat/completions : poser LLM_BASE_URL (et LLM_MODEL)";
    };
};
export declare const MODELS_DATA: {
    readonly opus: {
        readonly provider: "anthropic";
        readonly model_id: "claude-opus-5";
        readonly price_in: 5;
        readonly price_out: 25;
        readonly note: "raisonnement adaptatif actif par défaut ; contexte 1M";
    };
    readonly sonnet: {
        readonly provider: "anthropic";
        readonly model_id: "claude-sonnet-5";
        readonly price_in: 2;
        readonly price_out: 10;
        readonly note: "tarif 2/10 (table Anthropic) ; monumia notait 3/15 après le 2026-08-31 — À REVÉRIFIER sur la page de tarifs";
    };
    readonly haiku: {
        readonly provider: "anthropic";
        readonly model_id: "claude-haiku-4-5";
        readonly price_in: 1;
        readonly price_out: 5;
        readonly overrides: {
            readonly caps: {
                readonly effort: false;
                readonly thinking: "budget";
                readonly temperature: true;
            };
        };
        readonly note: "génération 4.5 : `effort` errore, le raisonnement se règle en budget_tokens ; contexte 200K";
    };
    readonly fable: {
        readonly provider: "anthropic";
        readonly model_id: "claude-fable-5-1";
        readonly price_in: 10;
        readonly price_out: 50;
        readonly price_cache_read: 0.25;
        readonly overrides: {
            readonly caps: {
                readonly forced_tool_choice: false;
            };
        };
        readonly note: "tool_choice any/tool → 400 : la lib dégrade en auto + instruction ; raisonnement toujours actif";
    };
    readonly "opus-4.8": {
        readonly provider: "anthropic";
        readonly model_id: "claude-opus-4-8";
        readonly price_in: 5;
        readonly price_out: 25;
        readonly note: "thinking adaptive à poser explicitement (omis = pas de raisonnement, contrairement à Opus 5)";
    };
    readonly "sonnet-4.6": {
        readonly provider: "anthropic";
        readonly model_id: "claude-sonnet-4-6";
        readonly price_in: 3;
        readonly price_out: 15;
        readonly overrides: {
            readonly caps: {
                readonly temperature: true;
            };
            readonly wire: {
                readonly effort_values: readonly ["low", "medium", "high", "max"];
            };
        };
        readonly note: "pas de `xhigh` sur la génération 4.6 (arrivé avec Opus 4.7)";
    };
    readonly "gpt-luna": {
        readonly provider: "openai";
        readonly model_id: "gpt-5.6-luna";
        readonly price_in: 1.25;
        readonly price_out: 10;
        readonly id_verified: false;
    };
    readonly "gpt-terra": {
        readonly provider: "openai";
        readonly model_id: "gpt-5.6-terra";
        readonly price_in: 0.25;
        readonly price_out: 2;
        readonly id_verified: false;
    };
    readonly "ds-flash": {
        readonly provider: "deepseek";
        readonly model_id: "deepseek-v4-flash";
        readonly price_in: 0.28;
        readonly price_out: 0.42;
        readonly note: "id confirmé : déjà en production chez monumia";
    };
    readonly "ds-pro": {
        readonly provider: "deepseek";
        readonly model_id: "deepseek-v4-pro";
        readonly price_in: 0.55;
        readonly price_out: 2.2;
        readonly note: "id confirmé ; contexte 1M";
    };
    readonly glm: {
        readonly provider: "zai";
        readonly model_id: "glm-5.3";
        readonly id_verified: false;
        readonly note: "tarif à renseigner après confirmation chez z.ai";
    };
    readonly "glm-flash": {
        readonly provider: "zai";
        readonly model_id: "glm-5.3-flash";
        readonly id_verified: false;
        readonly note: "tarif à renseigner";
    };
    readonly "gemini-flash": {
        readonly provider: "gemini";
        readonly model_id: "gemini-3-flash";
        readonly id_verified: false;
        readonly note: "tarif à renseigner";
    };
    readonly "gemini-pro": {
        readonly provider: "gemini";
        readonly model_id: "gemini-3-pro";
        readonly id_verified: false;
        readonly note: "tarif à renseigner";
    };
    readonly grok: {
        readonly provider: "xai";
        readonly model_id: "grok-4";
        readonly id_verified: false;
        readonly note: "tarif à renseigner";
    };
    readonly "grok-fast": {
        readonly provider: "xai";
        readonly model_id: "grok-4-fast";
        readonly id_verified: false;
        readonly note: "tarif à renseigner";
    };
    readonly "kimi-k2.7": {
        readonly provider: "moonshot";
        readonly model_id: "kimi-k2.7";
        readonly price_in: 0.6;
        readonly price_out: 2.5;
        readonly id_verified: false;
    };
    readonly "kimi-k3": {
        readonly provider: "moonshot";
        readonly model_id: "kimi-k3";
        readonly price_in: 1;
        readonly price_out: 4;
        readonly id_verified: false;
    };
    readonly mistral: {
        readonly provider: "mistral";
        readonly model_id: "mistral-large-latest";
        readonly id_verified: false;
        readonly note: "alias glissant côté Mistral ; tarif à renseigner";
    };
    readonly "mistral-medium": {
        readonly provider: "mistral";
        readonly model_id: "mistral-medium-latest";
        readonly id_verified: false;
        readonly note: "tarif à renseigner";
    };
    readonly "or-glm": {
        readonly provider: "openrouter";
        readonly model_id: "z-ai/glm-5.3-flash";
        readonly price_in: 0.07;
        readonly price_out: 0.25;
        readonly overrides: {
            readonly caps: {
                readonly structured: "json_schema";
            };
        };
        readonly note: "id, tarif et response_format relevés sur /api/v1/models le 2026-08-28";
    };
    readonly "or-kimi": {
        readonly provider: "openrouter";
        readonly model_id: "moonshotai/kimi-k2.6";
        readonly price_in: 0.95;
        readonly price_out: 4;
        readonly overrides: {
            readonly caps: {
                readonly structured: "json_schema";
            };
        };
        readonly note: "k2.7 n'existe pas chez OpenRouter (seul k2.7-code) ; relevé le 2026-08-28";
    };
};
/** Alias du registre, en type littéral : une faute de frappe se voit à la compilation. */
export type ModelAlias = keyof typeof MODELS_DATA;
export type ProviderName = keyof typeof PROVIDERS_DATA;
//# sourceMappingURL=registry.data.d.ts.map