"""`Client` : configuration réutilisable, et le pipeline d'un appel.

Les fonctions de module (`providall.complete(...)`) délèguent à un `Client()`
par défaut. Un projet qui veut fixer un modèle, un timeout ou un hook une fois
pour toutes se construit son propre `Client` ; les deux surfaces sont les mêmes.

Sync et async partagent tout sauf la ligne d'envoi. Pas d'`asyncio.run()` caché
dans les wrappers sync : un `complete()` appelé depuis une boucle événementielle
déjà démarrée exploserait, et c'est exactement là que se cachent les bugs les
plus longs à trouver.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Iterator, Sequence
from typing import Any

from . import hooks
from .config import (
    DEFAULT_RETRIES,
    DEFAULT_TIMEOUT_S,
    api_key_for,
    base_url_for,
    env_defaults,
    normalize_effort,
    resolve,
)
from .errors import MissingKeyError, ProvidallError
from .pricing import compute_cost
from .providers import adapter_for
from .providers.base import (
    Request,
    ToolDef,
    as_tool_defs,
    check_capabilities,
    map_exception,
    normalize_prompt,
)
from .retry import RetryPolicy, arun_with_retry, run_with_retry
from .stream import Done, StreamEvent
from .types import Effort, ModelSpec, Prompt, Response, ToolChoice


class Client:
    """Config réutilisable. Chaque option est aussi surchargeable à l'appel."""

    def __init__(
        self,
        model: str | None = None,
        *,
        role: str | None = None,
        timeout: float | None = None,
        max_tokens: int | None = None,
        effort: Effort | str | None = None,
        temperature: float | None = None,
        retry: RetryPolicy | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        on_response: hooks.ResponseHook | None = None,
        label: str | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.model = model
        self.role = role
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.effort: Effort | None = normalize_effort(effort) if isinstance(effort, str) else effort
        self.temperature = temperature
        self.retry = retry
        self.api_key = api_key
        self.base_url = base_url
        self.on_response = on_response
        self.label = label
        self.env = env

    def with_options(self, **overrides: Any) -> Client:
        """Copie du client, quelques réglages changés. Le client d'origine est intact."""
        courant = {
            "model": self.model,
            "role": self.role,
            "timeout": self.timeout,
            "max_tokens": self.max_tokens,
            "effort": self.effort,
            "temperature": self.temperature,
            "retry": self.retry,
            "api_key": self.api_key,
            "base_url": self.base_url,
            "on_response": self.on_response,
            "label": self.label,
            "env": self.env,
        }
        courant.update(overrides)
        modele = courant.pop("model")
        return Client(modele, **courant)  # type: ignore[arg-type]

    # ------------------------------------------------------------- pipeline

    def prepare(
        self,
        prompt: Prompt,
        *,
        system: str | None = None,
        model: str | None = None,
        role: str | None = None,
        max_tokens: int | None = None,
        effort: Effort | str | None = None,
        temperature: float | None = None,
        timeout: float | None = None,
        tools: Sequence[Any] | None = None,
        tool_choice: ToolChoice | None = None,
        json_schema: dict[str, Any] | None = None,
        stream: bool = False,
        label: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> Request:
        """Résout tout et vérifie tout, sans rien envoyer.

        Exposé publiquement parce que c'est ce qu'on veut inspecter quand un
        appel part de travers : `client.prepare(...)` puis
        `adapter_for(req.spec.protocol).build(req)` donne le corps exact.
        """
        defauts = env_defaults(self.env)
        resolution = resolve(model or self.model, role=role or self.role, env=self.env)
        spec = resolution.spec

        cle = api_key or self.api_key or api_key_for(spec, self.env)
        if not cle and spec.requires_key:
            raise MissingKeyError(spec.api_key_env, provider=spec.provider, key_url=spec.key_url)
        url = base_url or self.base_url or base_url_for(spec, self.env)[0]

        messages, systeme = normalize_prompt(prompt, system)
        effort_final: Effort | None = (
            normalize_effort(effort) if isinstance(effort, str) else effort
        )
        if effort_final is None:
            effort_final = self.effort or defauts.effort or spec.effort

        req = Request(
            spec=spec,
            messages=messages,
            system=systeme,
            max_tokens=max_tokens or self.max_tokens or defauts.max_tokens or spec.max_tokens,
            effort=effort_final,
            temperature=_premier(temperature, self.temperature, defauts.temperature),
            tools=as_tool_defs(tools),
            tool_choice=tool_choice,
            json_schema=json_schema,
            stream=stream,
            timeout=timeout or self.timeout or defauts.timeout or DEFAULT_TIMEOUT_S,
            api_key=cle,
            base_url=url,
            label=label or self.label or spec.alias,
        )
        check_capabilities(req)
        return req

    def _policy(self) -> RetryPolicy:
        if self.retry is not None:
            return self.retry
        depuis_env = env_defaults(self.env).retries
        return RetryPolicy(retries=depuis_env if depuis_env is not None else DEFAULT_RETRIES)

    def _finish(
        self, response: Response, spec: ModelSpec, started: float, attempts: int, label: str
    ) -> Response:
        response.latency_s = time.monotonic() - started
        response.attempts = attempts
        response.cost_usd = compute_cost(spec, response.usage)
        hooks.emit(response, label=label, extra=self.on_response)
        return response

    def _failed(
        self, error: ProvidallError, spec: ModelSpec, started: float, attempts: int, label: str
    ) -> Response:
        """`Response` d'échec, pour les variantes `try_*` qui ne lèvent jamais."""
        reponse = Response(
            model=spec.alias,
            model_id=spec.model_id,
            provider=spec.provider,
            latency_s=time.monotonic() - started,
            attempts=attempts,
            error=error,
        )
        hooks.emit(reponse, label=label, extra=self.on_response)
        return reponse

    # -------------------------------------------------------------- complete

    def complete(self, prompt: Prompt, **kw: Any) -> Response:
        """Un aller-retour. Lève une `ProvidallError` typée en cas d'échec."""
        req = self.prepare(prompt, **kw)
        return self._run(req)

    async def acomplete(self, prompt: Prompt, **kw: Any) -> Response:
        req = self.prepare(prompt, **kw)
        return await self._arun(req)

    def try_complete(self, prompt: Prompt, **kw: Any) -> Response:
        """Ne lève JAMAIS : l'erreur est dans `.error`, et `.ok` dit si c'est passé.

        Pour les traitements en lot — un fournisseur en panne ne doit pas
        interrompre un passage sur 142 fiches ; l'appelant escalade l'élément
        concerné et continue.
        """
        depart = time.monotonic()
        try:
            req = self.prepare(prompt, **kw)
        except ProvidallError as exc:
            return self._failed(exc, _spec_inconnu(exc), depart, 0, self.label or "?")
        try:
            return self._run(req)
        except ProvidallError as exc:
            return self._failed(exc, req.spec, depart, exc.attempts, req.label)

    async def atry_complete(self, prompt: Prompt, **kw: Any) -> Response:
        depart = time.monotonic()
        try:
            req = self.prepare(prompt, **kw)
        except ProvidallError as exc:
            return self._failed(exc, _spec_inconnu(exc), depart, 0, self.label or "?")
        try:
            return await self._arun(req)
        except ProvidallError as exc:
            return self._failed(exc, req.spec, depart, exc.attempts, req.label)

    # ------------------------------------------------------------ exécution

    def _run(self, req: Request) -> Response:
        adaptateur = adapter_for(req.spec.protocol)
        corps = adaptateur.build(req)
        depart = time.monotonic()

        def tentative(_n: int) -> Response:
            try:
                brut = adaptateur.send(req, corps)
            except ProvidallError:
                raise
            except Exception as exc:  # noqa: BLE001 — toute panne fournisseur est traduite
                raise map_exception(exc, provider=req.spec.provider, model=req.spec.alias) from exc
            return adaptateur.parse(brut, req)

        reponse, essais = run_with_retry(self._policy(), tentative, on_retry=_journaliser)
        return self._finish(reponse, req.spec, depart, essais, req.label)

    async def _arun(self, req: Request) -> Response:
        adaptateur = adapter_for(req.spec.protocol)
        corps = adaptateur.build(req)
        depart = time.monotonic()

        async def tentative(_n: int) -> Response:
            try:
                brut = await adaptateur.asend(req, corps)
            except ProvidallError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise map_exception(exc, provider=req.spec.provider, model=req.spec.alias) from exc
            return adaptateur.parse(brut, req)

        reponse, essais = await arun_with_retry(self._policy(), tentative, on_retry=_journaliser)
        return self._finish(reponse, req.spec, depart, essais, req.label)

    # ---------------------------------------------------------------- stream

    def stream(self, prompt: Prompt, **kw: Any) -> Iterator[StreamEvent]:
        """Flux d'événements : `TextDelta`* puis `Done(response)`.

        Le `Done` final porte la `Response` complète — usage, coût,
        `finish_reason` — donc consommer les deltas et vouloir le total ne sont
        pas exclusifs.
        """
        req = self.prepare(prompt, stream=True, **kw)
        adaptateur = adapter_for(req.spec.protocol)
        corps = adaptateur.build(req)
        politique = self._policy()

        for tentative in range(politique.retries + 1):
            depart = time.monotonic()
            emis = False
            try:
                for evenement in _stream_events(adaptateur, req, corps):
                    if isinstance(evenement, Done):
                        yield Done(
                            self._finish(
                                evenement.response, req.spec, depart, tentative + 1, req.label
                            )
                        )
                    else:
                        emis = True
                        yield evenement
                return
            except Exception as exc:  # noqa: BLE001
                erreur = (
                    exc
                    if isinstance(exc, ProvidallError)
                    else map_exception(exc, provider=req.spec.provider, model=req.spec.alias)
                )
                # Une fois des octets rendus à l'appelant, plus de relance : il
                # a déjà affiché du texte, rejouer le dupliquerait.
                if not erreur.retryable or emis or tentative == politique.retries:
                    erreur.attempts = tentative + 1
                    raise erreur from exc
                pause = politique.delay(tentative + 1, erreur)
                _journaliser(tentative + 1, erreur, pause)
                time.sleep(pause)

    async def astream(self, prompt: Prompt, **kw: Any) -> AsyncIterator[StreamEvent]:
        req = self.prepare(prompt, stream=True, **kw)
        adaptateur = adapter_for(req.spec.protocol)
        corps = adaptateur.build(req)
        depart = time.monotonic()

        try:
            async for evenement in _astream_events(adaptateur, req, corps):
                if isinstance(evenement, Done):
                    yield Done(self._finish(evenement.response, req.spec, depart, 1, req.label))
                else:
                    yield evenement
        except ProvidallError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise map_exception(exc, provider=req.spec.provider, model=req.spec.alias) from exc

    # ------------------------------------------------- JSON validé / outils

    def complete_json(self, schema: Any, prompt: Prompt, **kw: Any) -> Any:
        from .structured import complete_json as _impl

        return _impl(self, schema, prompt, **kw)

    async def acomplete_json(self, schema: Any, prompt: Prompt, **kw: Any) -> Any:
        from .structured import acomplete_json as _impl

        return await _impl(self, schema, prompt, **kw)

    def try_complete_json(self, schema: Any, prompt: Prompt, **kw: Any) -> Any:
        from .structured import try_complete_json as _impl

        return _impl(self, schema, prompt, **kw)

    async def atry_complete_json(self, schema: Any, prompt: Prompt, **kw: Any) -> Any:
        from .structured import atry_complete_json as _impl

        return await _impl(self, schema, prompt, **kw)

    def tool_loop(self, prompt: Prompt, *, tools: Sequence[Any], **kw: Any) -> Any:
        from .tools import tool_loop as _impl

        return _impl(self, prompt, tools=tools, **kw)

    async def atool_loop(self, prompt: Prompt, *, tools: Sequence[Any], **kw: Any) -> Any:
        from .tools import atool_loop as _impl

        return await _impl(self, prompt, tools=tools, **kw)


# --------------------------------------------------------------------------
# Streaming : la seule partie qui diffère par adaptateur
# --------------------------------------------------------------------------


def _stream_events(adaptateur: Any, req: Request, corps: dict[str, Any]) -> Iterator[StreamEvent]:
    if adaptateur.protocol == "anthropic":
        from .providers.anthropic import map_stream_event

        with adaptateur.stream_ctx(req, corps) as flux:
            for evenement in flux:
                yield from map_stream_event(evenement)
            final = flux.get_final_message()
        yield Done(adaptateur.parse(final, req))
    else:
        from .providers.openai_compat import ChunkAccumulator

        accumulateur = ChunkAccumulator()
        for morceau in adaptateur.stream_ctx(req, corps):
            yield from accumulateur.feed(morceau)
        yield Done(adaptateur.parse(accumulateur.result(), req))


async def _astream_events(
    adaptateur: Any, req: Request, corps: dict[str, Any]
) -> AsyncIterator[StreamEvent]:
    if adaptateur.protocol == "anthropic":
        from .providers.anthropic import map_stream_event

        async with adaptateur.astream_ctx(req, corps) as flux:
            async for evenement in flux:
                for traduit in map_stream_event(evenement):
                    yield traduit
            final = await flux.get_final_message()
        yield Done(adaptateur.parse(final, req))
    else:
        from .providers.openai_compat import ChunkAccumulator

        accumulateur = ChunkAccumulator()
        async for morceau in await adaptateur.astream_ctx(req, corps):
            for traduit in accumulateur.feed(morceau):
                yield traduit
        yield Done(adaptateur.parse(accumulateur.result(), req))


def _journaliser(tentative: int, erreur: ProvidallError, pause: float) -> None:
    hooks.logger.warning("%s — relance %d dans %.0fs", erreur, tentative, pause)


def _premier(*valeurs: float | None) -> float | None:
    """Première valeur non nulle. `0.0` compte comme une valeur (temperature=0)."""
    for v in valeurs:
        if v is not None:
            return v
    return None


def _spec_inconnu(exc: ProvidallError) -> ModelSpec:
    """Spec factice pour une erreur survenue AVANT toute résolution de modèle."""
    from .types import Caps, Wire

    return ModelSpec(
        alias=exc.model or "?",
        provider=exc.provider or "?",
        protocol="openai_compat",
        model_id=exc.model or "?",
        api_key_env="",
        base_url="",
        requires_key=False,
        key_url="",
        caps=Caps(False, "prompt", False, "none", False, False, False, False),
        wire=Wire("max_tokens", None, ()),
        max_tokens=0,
        effort=None,
    )


# --------------------------------------------------------------------------
# Surface de module : un `Client()` par défaut
# --------------------------------------------------------------------------

_default = Client()


def default_client() -> Client:
    return _default


def complete(prompt: Prompt, **kw: Any) -> Response:
    return _default.complete(prompt, **kw)


async def acomplete(prompt: Prompt, **kw: Any) -> Response:
    return await _default.acomplete(prompt, **kw)


def try_complete(prompt: Prompt, **kw: Any) -> Response:
    return _default.try_complete(prompt, **kw)


async def atry_complete(prompt: Prompt, **kw: Any) -> Response:
    return await _default.atry_complete(prompt, **kw)


def stream(prompt: Prompt, **kw: Any) -> Iterator[StreamEvent]:
    return _default.stream(prompt, **kw)


def astream(prompt: Prompt, **kw: Any) -> AsyncIterator[StreamEvent]:
    return _default.astream(prompt, **kw)


__all__ = [
    "Client",
    "Request",
    "ToolDef",
    "acomplete",
    "astream",
    "atry_complete",
    "complete",
    "default_client",
    "stream",
    "try_complete",
]
