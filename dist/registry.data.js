/**
 * GÉNÉRÉ PAR scripts/gen-registry.mjs — NE PAS ÉDITER À LA MAIN.
 *
 * Source : registry/providers.json et registry/models.json.
 * Régénérer : npm run gen (ou node scripts/gen-registry.mjs).
 */
export const PROVIDERS_DATA = {
    "anthropic": {
        "protocol": "anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "api_key_env": "ANTHROPIC_API_KEY",
        "aliases": [
            "claude"
        ],
        "default_model": "claude-sonnet-5",
        "key_url": "https://console.anthropic.com/settings/keys",
        "note": "API Messages native : seule à exposer output_config.format, output_config.effort et le raisonnement adaptatif"
    },
    "openai": {
        "protocol": "openai_compat",
        "base_url": "https://api.openai.com/v1",
        "api_key_env": "OPENAI_API_KEY",
        "aliases": [
            "gpt",
            "chatgpt"
        ],
        "default_model": "gpt-5.6-terra",
        "key_url": "https://platform.openai.com/api-keys",
        "caps": {
            "structured": "json_schema",
            "effort": true,
            "temperature": false
        },
        "wire": {
            "max_tokens_param": "max_completion_tokens",
            "effort_param": "reasoning_effort",
            "effort_values": [
                "none",
                "low",
                "medium",
                "high"
            ]
        },
        "note": "modèles à raisonnement : max_completion_tokens (400 sur max_tokens), temperature non par défaut refusée"
    },
    "gemini": {
        "protocol": "openai_compat",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "api_key_env": "GEMINI_API_KEY",
        "aliases": [
            "google"
        ],
        "default_model": "gemini-3-flash",
        "key_url": "https://aistudio.google.com/apikey",
        "caps": {
            "structured": "json_schema"
        }
    },
    "xai": {
        "protocol": "openai_compat",
        "base_url": "https://api.x.ai/v1",
        "api_key_env": "XAI_API_KEY",
        "aliases": [
            "grok"
        ],
        "default_model": "grok-4",
        "key_url": "https://console.x.ai"
    },
    "moonshot": {
        "protocol": "openai_compat",
        "base_url": "https://api.moonshot.ai/v1",
        "api_key_env": "MOONSHOT_API_KEY",
        "aliases": [
            "kimi"
        ],
        "default_model": "kimi-k2.7",
        "key_url": "https://platform.moonshot.ai/console/api-keys"
    },
    "zai": {
        "protocol": "openai_compat",
        "base_url": "https://api.z.ai/api/paas/v4",
        "api_key_env": "ZAI_API_KEY",
        "aliases": [
            "glm",
            "z"
        ],
        "default_model": "glm-5.3-flash",
        "key_url": "https://z.ai/manage-apikey/apikey-list"
    },
    "zai_anthropic": {
        "protocol": "anthropic",
        "base_url": "https://api.z.ai/api/anthropic",
        "api_key_env": "ZAI_API_KEY",
        "aliases": [
            "glm-anthropic"
        ],
        "default_model": "glm-5.3",
        "key_url": "https://z.ai/manage-apikey/apikey-list",
        "caps": {
            "structured": "prompt",
            "thinking": "none",
            "effort": false
        },
        "note": "endpoint Anthropic-compatible de z.ai : caps prudentes (output_config non testé) — cf. §14 du plan"
    },
    "mistral": {
        "protocol": "openai_compat",
        "base_url": "https://api.mistral.ai/v1",
        "api_key_env": "MISTRAL_API_KEY",
        "aliases": [
            "mistralai"
        ],
        "default_model": "mistral-large-latest",
        "key_url": "https://console.mistral.ai/api-keys"
    },
    "deepseek": {
        "protocol": "openai_compat",
        "base_url": "https://api.deepseek.com",
        "api_key_env": "DEEPSEEK_API_KEY",
        "aliases": [
            "ds"
        ],
        "default_model": "deepseek-v4-flash",
        "key_url": "https://platform.deepseek.com/api_keys",
        "caps": {
            "effort": true,
            "temperature": false
        },
        "wire": {
            "effort_param": "reasoning_effort",
            "effort_values": [
                "low",
                "high",
                "max"
            ],
            "thinking_toggle": "deepseek"
        },
        "defaults": {
            "max_tokens": 32000
        },
        "note": "V4 : thinking activé par défaut (effort high, ~8 000 jetons de reasoning_content, d'où le budget doublé). reasoning_effort low|high|max ; effort none → thinking.type=disabled. temperature refusée en mode thinking."
    },
    "openrouter": {
        "protocol": "openai_compat",
        "base_url": "https://openrouter.ai/api/v1",
        "api_key_env": "OPENROUTER_API_KEY",
        "aliases": [
            "or"
        ],
        "default_model": "z-ai/glm-5.3-flash",
        "key_url": "https://openrouter.ai/settings/keys",
        "caps": {
            "structured": "prompt",
            "effort": true
        },
        "wire": {
            "effort_param": "openrouter_reasoning",
            "effort_values": [
                "low",
                "medium",
                "high"
            ]
        },
        "defaults": {
            "max_tokens": 32000,
            "effort": "medium"
        },
        "note": "passerelle : identifiant préfixé de l'éditeur, tarif propre à chaque modèle ; response_format transmis tel quel au modèle routé (400 s'il ne le connaît pas) ; effort medium mesuré le 2026-09-01"
    },
    "groq": {
        "protocol": "openai_compat",
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": "GROQ_API_KEY",
        "aliases": [],
        "default_model": "llama-3.3-70b-versatile",
        "key_url": "https://console.groq.com/keys",
        "caps": {
            "structured": "json_schema"
        }
    },
    "ollama": {
        "protocol": "openai_compat",
        "base_url": "http://localhost:11434/v1",
        "api_key_env": "OLLAMA_API_KEY",
        "aliases": [],
        "default_model": "",
        "requires_key": false,
        "caps": {
            "vision": false
        },
        "note": "serveur local : aucune clé, aucun en-tête Authorization"
    },
    "openai_compat": {
        "protocol": "openai_compat",
        "base_url": "",
        "api_key_env": "LLM_API_KEY",
        "aliases": [
            "compat",
            "custom",
            "local",
            "vllm",
            "lmstudio",
            "together",
            "qwen"
        ],
        "default_model": "",
        "requires_key": false,
        "caps": {
            "vision": false
        },
        "note": "n'importe quel serveur /chat/completions : poser LLM_BASE_URL (et LLM_MODEL)"
    }
};
export const MODELS_DATA = {
    "opus": {
        "provider": "anthropic",
        "model_id": "claude-opus-5",
        "price_in": 5,
        "price_out": 25,
        "note": "raisonnement adaptatif actif par défaut ; contexte 1M"
    },
    "sonnet": {
        "provider": "anthropic",
        "model_id": "claude-sonnet-5",
        "price_in": 2,
        "price_out": 10,
        "note": "tarif 2/10 (table Anthropic) ; monumia notait 3/15 après le 2026-08-31 — À REVÉRIFIER sur la page de tarifs"
    },
    "haiku": {
        "provider": "anthropic",
        "model_id": "claude-haiku-4-5",
        "price_in": 1,
        "price_out": 5,
        "overrides": {
            "caps": {
                "effort": false,
                "thinking": "budget",
                "temperature": true
            }
        },
        "note": "génération 4.5 : `effort` errore, le raisonnement se règle en budget_tokens ; contexte 200K"
    },
    "fable": {
        "provider": "anthropic",
        "model_id": "claude-fable-5-1",
        "price_in": 10,
        "price_out": 50,
        "price_cache_read": 0.25,
        "overrides": {
            "caps": {
                "forced_tool_choice": false
            }
        },
        "note": "tool_choice any/tool → 400 : la lib dégrade en auto + instruction ; raisonnement toujours actif"
    },
    "opus-4.8": {
        "provider": "anthropic",
        "model_id": "claude-opus-4-8",
        "price_in": 5,
        "price_out": 25,
        "note": "thinking adaptive à poser explicitement (omis = pas de raisonnement, contrairement à Opus 5)"
    },
    "sonnet-4.6": {
        "provider": "anthropic",
        "model_id": "claude-sonnet-4-6",
        "price_in": 3,
        "price_out": 15,
        "overrides": {
            "caps": {
                "temperature": true
            },
            "wire": {
                "effort_values": [
                    "low",
                    "medium",
                    "high",
                    "max"
                ]
            }
        },
        "note": "pas de `xhigh` sur la génération 4.6 (arrivé avec Opus 4.7)"
    },
    "gpt-luna": {
        "provider": "openai",
        "model_id": "gpt-5.6-luna",
        "price_in": 1.25,
        "price_out": 10,
        "id_verified": false
    },
    "gpt-terra": {
        "provider": "openai",
        "model_id": "gpt-5.6-terra",
        "price_in": 0.25,
        "price_out": 2,
        "id_verified": false
    },
    "ds-flash": {
        "provider": "deepseek",
        "model_id": "deepseek-v4-flash",
        "price_in": 0.28,
        "price_out": 0.42,
        "note": "id confirmé : déjà en production chez monumia"
    },
    "ds-pro": {
        "provider": "deepseek",
        "model_id": "deepseek-v4-pro",
        "price_in": 0.55,
        "price_out": 2.2,
        "note": "id confirmé ; contexte 1M"
    },
    "glm": {
        "provider": "zai",
        "model_id": "glm-5.3",
        "id_verified": false,
        "note": "tarif à renseigner après confirmation chez z.ai"
    },
    "glm-flash": {
        "provider": "zai",
        "model_id": "glm-5.3-flash",
        "id_verified": false,
        "note": "tarif à renseigner"
    },
    "gemini-flash": {
        "provider": "gemini",
        "model_id": "gemini-3-flash",
        "id_verified": false,
        "note": "tarif à renseigner"
    },
    "gemini-pro": {
        "provider": "gemini",
        "model_id": "gemini-3-pro",
        "id_verified": false,
        "note": "tarif à renseigner"
    },
    "grok": {
        "provider": "xai",
        "model_id": "grok-4",
        "id_verified": false,
        "note": "tarif à renseigner"
    },
    "grok-fast": {
        "provider": "xai",
        "model_id": "grok-4-fast",
        "id_verified": false,
        "note": "tarif à renseigner"
    },
    "kimi-k2.7": {
        "provider": "moonshot",
        "model_id": "kimi-k2.7",
        "price_in": 0.6,
        "price_out": 2.5,
        "id_verified": false
    },
    "kimi-k3": {
        "provider": "moonshot",
        "model_id": "kimi-k3",
        "price_in": 1,
        "price_out": 4,
        "id_verified": false
    },
    "mistral": {
        "provider": "mistral",
        "model_id": "mistral-large-latest",
        "id_verified": false,
        "note": "alias glissant côté Mistral ; tarif à renseigner"
    },
    "mistral-medium": {
        "provider": "mistral",
        "model_id": "mistral-medium-latest",
        "id_verified": false,
        "note": "tarif à renseigner"
    },
    "mistral-small": {
        "provider": "mistral",
        "model_id": "mistral-small-2603",
        "price_in": 0.15,
        "price_out": 0.6,
        "overrides": {
            "caps": {
                "effort": true
            },
            "wire": {
                "effort_param": "reasoning_effort",
                "effort_values": [
                    "none",
                    "high"
                ]
            }
        },
        "id_verified": false,
        "note": "Mistral Small 4, raisonnement hybride : reasoning_effort none|high (doc Mistral). Tarif relevé le 2026-10-03 ; lecture en cache à 10 %, seulement si la requête porte `prompt_cache_key` (extra_body)"
    },
    "or-glm": {
        "provider": "openrouter",
        "model_id": "z-ai/glm-5.3-flash",
        "price_in": 0.07,
        "price_out": 0.25,
        "overrides": {
            "caps": {
                "structured": "json_schema"
            }
        },
        "note": "id, tarif et response_format relevés sur /api/v1/models le 2026-08-28"
    },
    "or-kimi": {
        "provider": "openrouter",
        "model_id": "moonshotai/kimi-k2.6",
        "price_in": 0.95,
        "price_out": 4,
        "overrides": {
            "caps": {
                "structured": "json_schema"
            }
        },
        "note": "k2.7 n'existe pas chez OpenRouter (seul k2.7-code) ; relevé le 2026-08-28"
    }
};
