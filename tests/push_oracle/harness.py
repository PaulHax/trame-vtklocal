"""Oracle runner: drive PushSync, capture wire messages, compare ledgers.

The harness owns the fake server, ``PushSync`` construction, full-translate
call counting, and per-step assertions. Tests build an :class:`OracleScene`
factory and a list of :class:`OracleStep` mutations, then call
:func:`run_oracle_steps` to assert end-to-end correctness:

- the right wire topic / kind was published
- patch cases triggered no fresh full ``translate_scene(...)`` call
- the cumulative server ledger for each client matches a freshly-taken
  shadow snapshot (the same state a brand-new client would resync to)
"""

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from trame_vtklocal.module.vtkjs_translator import translate_scene
from trame_vtklocal.widgets.push_sync import PushSync, _state_for_ledger

from .normalize import first_difference, make_resolver, normalize
from .scenes import OracleScene


SHADOW_CLIENT_ID = "__oracle_shadow__"


@dataclass
class OracleStep:
    """One mutation + the wire behavior it must produce."""

    name: str
    mutate: Callable[[OracleScene], None]
    publish: Literal["update", "flush", "extra-only"] = "update"
    extra: Any = None
    expected_topic: str = "trame.vtk.patch"
    expected_kind: str = "patch"
    expected_full_translate_delta: int = 0
    expected_fallback_reason: str | None = None
    # Optional substring match for fallback reasons that include ids.
    fallback_reason_contains: str | None = None
    # Optional structural assertion on the published payload.
    assert_message: Callable[[dict], None] | None = None


class OracleMismatch(AssertionError):
    """Raised when a step's ledger diverges from a fresh shadow snapshot."""

    def __init__(self, *, fixture, step, report):
        self.fixture = fixture
        self.step = step
        self.report = report
        super().__init__(self._format())

    def _format(self):
        lines = [
            f"OracleMismatch in fixture {self.fixture!r} step {self.step!r}:"
        ]
        for key, value in self.report.items():
            lines.append(f"  {key}: {value}")
        return "\n".join(lines)


class _FakeProtocol:
    def __init__(self):
        self.messages = []

    def publish(self, topic, payload, client_id=None):
        # Patch payloads can mutate after publish (sequence advances live).
        # The wire message is whatever was passed at publish time, so we
        # snapshot here.
        self.messages.append((topic, deepcopy(payload), client_id))


class _FakeServer:
    def __init__(self):
        self.protocol = _FakeProtocol()


def _make_real_push_sync(server, scene: OracleScene):
    """Wrap ``translate_scene`` so we can count full translation calls."""
    counters = {"full_translate": 0}

    def get_state(version_registry=None, collection_tracker=None):
        counters["full_translate"] += 1
        scene.render_window.Render()
        scene.api.vtk_object_manager.UpdateStatesFromObjects()
        return translate_scene(
            scene.api.vtk_object_manager,
            scene.render_window_id,
            collection_tracker,
            version_registry,
            scene.render_window_id,
        )

    push_sync = PushSync(
        server,
        get_state,
        lambda vtk_object: str(scene.api.vtk_object_manager.GetId(vtk_object)),
        render_window_id=scene.render_window_id,
        api=scene.api,
    )
    return push_sync, counters


def take_shadow_snapshot(push_sync):
    """Return a fresh full state without disturbing dirty bookkeeping.

    Re-running the full-state callback fires ``Render()`` /
    ``UpdateStatesFromObjects()`` which can in turn fire ``ModifiedEvent`` on
    cameras and mappers, polluting ``_dirty_object_ids`` for the next step.
    It also writes to ``_collection_trackers[SHADOW_CLIENT_ID]``. We snapshot
    those, run the translator, then restore.
    """
    saved_dirty_object_ids = set(push_sync._dirty_object_ids)
    saved_dirty_owner_ids = {
        key: set(value) for key, value in push_sync._dirty_owner_ids.items()
    }
    saved_dirty_pipeline_updates = {
        key: dict(value) for key, value in push_sync._dirty_pipeline_updates.items()
    }
    saved_dirty_structural_ids = set(push_sync._dirty_structural_ids)
    saved_dirty_structure_pending = push_sync._dirty_structure_pending

    try:
        snapshot = push_sync._get_client_state(SHADOW_CLIENT_ID, reset_tracker=True)
    finally:
        push_sync._collection_trackers.pop(SHADOW_CLIENT_ID, None)
        push_sync._dirty_object_ids.clear()
        push_sync._dirty_object_ids.update(saved_dirty_object_ids)
        push_sync._dirty_owner_ids = {
            key: set(value) for key, value in saved_dirty_owner_ids.items()
        }
        push_sync._dirty_pipeline_updates = {
            key: dict(value) for key, value in saved_dirty_pipeline_updates.items()
        }
        push_sync._dirty_structural_ids = set(saved_dirty_structural_ids)
        push_sync._dirty_structure_pending = saved_dirty_structure_pending
    return snapshot


@dataclass
class OracleRunResult:
    push_sync: PushSync
    server: Any
    counters: dict
    scene: OracleScene
    messages_per_step: list = field(default_factory=list)
    fallback_records_per_step: list = field(default_factory=list)


def run_oracle_steps(
    scene_factory: Callable[[], OracleScene],
    steps: list[OracleStep],
    *,
    initial_clients: tuple[str, ...] = ("client-a",),
) -> OracleRunResult:
    """Run a list of oracle steps end-to-end on a fresh scene.

    Each step:
    1. captures the baseline full-translate count + clears wire messages
    2. applies the mutation
    3. invokes the publish action
    4. asserts the expected wire topic / kind / fallback reason
    5. asserts no surprise full translation happened for patch cases
    6. compares each client's cumulative ledger to a fresh shadow snapshot
    """
    scene = scene_factory()
    server = _FakeServer()
    push_sync, counters = _make_real_push_sync(server, scene)
    messages_per_step = []
    fallback_records_per_step = []
    fallback_records = []
    publish_full_fallback = push_sync._publish_full_fallback

    def record_full_fallback(client_id, seq, *args, **kwargs):
        reason = kwargs.get("reason")
        if reason is None and len(args) >= 2:
            reason = args[1]
        fallback_records.append({"client_id": client_id, "reason": reason})
        return publish_full_fallback(client_id, seq, *args, **kwargs)

    push_sync._publish_full_fallback = record_full_fallback

    try:
        for client_id in initial_clients:
            push_sync.client_resync(client_id)

        initial_full_translate = counters["full_translate"]
        if initial_full_translate != len(initial_clients):
            raise AssertionError(
                f"client_resync should call translate_scene once per client (got "
                f"{initial_full_translate} for {len(initial_clients)} clients)"
            )

        server.protocol.messages.clear()

        for step in steps:
            before_full = counters["full_translate"]
            server.protocol.messages.clear()
            fallback_records.clear()

            step.mutate(scene)

            if step.publish == "update":
                push_sync.update(extra=step.extra)
            elif step.publish == "flush":
                push_sync.flush(extra=step.extra)
            elif step.publish == "extra-only":
                push_sync.update(extra=step.extra)
            else:  # pragma: no cover
                raise ValueError(f"unknown publish action: {step.publish!r}")

            delta_full = counters["full_translate"] - before_full
            messages = list(server.protocol.messages)
            step_fallback_records = list(fallback_records)
            messages_per_step.append(messages)
            fallback_records_per_step.append(step_fallback_records)

            # Ledger equivalence is the core invariant. Check it first so
            # that "no message was published yet ledger went stale" surfaces
            # with a ledger-diff report instead of being masked by a
            # wire-only assertion.
            _assert_ledger_matches_shadow(push_sync, scene, step)
            _assert_step_expectations(
                scene,
                step,
                messages,
                delta_full,
                step_fallback_records,
            )

        return OracleRunResult(
            push_sync=push_sync,
            server=server,
            counters=counters,
            scene=scene,
            messages_per_step=messages_per_step,
            fallback_records_per_step=fallback_records_per_step,
        )
    finally:
        # Drop VTK observers held in closures over PushSync so per-test scenes
        # don't leak callbacks that fire during later GC and segfault.
        push_sync.cleanup()


def _assert_step_expectations(
    scene,
    step,
    messages,
    delta_full,
    fallback_records,
):
    if not messages:
        raise OracleMismatch(
            fixture=scene.name,
            step=step.name,
            report={
                "expected_topic": step.expected_topic,
                "actual": "no messages published",
            },
        )

    topics = [topic for topic, _payload, _client_id in messages]
    payloads = [payload for _topic, payload, _client_id in messages]
    kinds = [
        payload.get("kind") if isinstance(payload, dict) else None
        for payload in payloads
    ]

    if any(topic != step.expected_topic for topic in topics):
        raise OracleMismatch(
            fixture=scene.name,
            step=step.name,
            report={
                "expected_topic": step.expected_topic,
                "actual_topics": topics,
                "actual_kinds": kinds,
            },
        )

    if any(kind != step.expected_kind for kind in kinds):
        raise OracleMismatch(
            fixture=scene.name,
            step=step.name,
            report={
                "expected_kind": step.expected_kind,
                "actual_kinds": kinds,
                "actual_topics": topics,
            },
        )

    if delta_full != step.expected_full_translate_delta:
        raise OracleMismatch(
            fixture=scene.name,
            step=step.name,
            report={
                "expected_full_translate_delta": step.expected_full_translate_delta,
                "actual_full_translate_delta": delta_full,
                "actual_topics": topics,
                "actual_kinds": kinds,
            },
        )

    if step.assert_message is not None:
        for payload in payloads:
            step.assert_message(payload)

    if step.expected_kind != "full" and fallback_records:
        raise OracleMismatch(
            fixture=scene.name,
            step=step.name,
            report={
                "actual": "unexpected full fallback",
                "fallback_records": fallback_records,
                "expected_kind": step.expected_kind,
            },
        )

    if step.expected_kind == "full":
        if (
            step.expected_fallback_reason is None
            and step.fallback_reason_contains is None
        ):
            raise AssertionError(
                "full-fallback oracle steps must assert expected_fallback_reason "
                "or fallback_reason_contains"
            )
        if not fallback_records:
            raise OracleMismatch(
                fixture=scene.name,
                step=step.name,
                report={
                    "expected_kind": "full",
                    "actual": "no full fallback was recorded",
                },
            )

    if step.expected_fallback_reason is not None:
        if step.expected_kind != "full":
            raise AssertionError(
                "expected_fallback_reason only applies to full fallbacks"
            )
        if not fallback_records:
            raise OracleMismatch(
                fixture=scene.name,
                step=step.name,
                report={
                    "expected_fallback_reason": step.expected_fallback_reason,
                    "actual": "no full fallback was recorded",
                },
            )
        reasons = [record["reason"] for record in fallback_records]
        if any(reason != step.expected_fallback_reason for reason in reasons):
            raise OracleMismatch(
                fixture=scene.name,
                step=step.name,
                report={
                    "expected_fallback_reason": step.expected_fallback_reason,
                    "actual_fallback_reasons": reasons,
                },
            )
    if step.fallback_reason_contains is not None:
        if step.expected_kind != "full":
            raise AssertionError(
                "fallback_reason_contains only applies to full fallbacks"
            )
        if not fallback_records:
            raise OracleMismatch(
                fixture=scene.name,
                step=step.name,
                report={
                    "fallback_reason_contains": step.fallback_reason_contains,
                    "actual": "no full fallback was recorded",
                },
            )
        reasons = [record["reason"] for record in fallback_records]
        if any(
            step.fallback_reason_contains not in (reason or "")
            for reason in reasons
        ):
            raise OracleMismatch(
                fixture=scene.name,
                step=step.name,
                report={
                    "fallback_reason_contains": step.fallback_reason_contains,
                    "actual_fallback_reasons": reasons,
                },
            )


def _ledger_resolver(push_sync, scene):
    return make_resolver(push_sync, scene.api.vtk_object_manager)


def _assert_ledger_matches_shadow(push_sync, scene, step):
    resolver = _ledger_resolver(push_sync, scene)
    shadow_state = _state_for_ledger(take_shadow_snapshot(push_sync))
    shadow_normalized = normalize(shadow_state, resolver)

    for client_id, ledger in push_sync._client_states.items():
        ledger_normalized = normalize(ledger, resolver)
        if ledger_normalized != shadow_normalized:
            diff = first_difference(ledger_normalized, shadow_normalized)
            raise OracleMismatch(
                fixture=scene.name,
                step=step.name,
                report={
                    "client_id": client_id,
                    "ledger_epoch": push_sync._client_epochs.get(client_id),
                    "ledger_seq": push_sync._client_sequences.get(client_id),
                    "first_difference": diff,
                },
            )
