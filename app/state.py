"""In-memory store voor de laatste status per (intersectie, signaalgroep)."""

from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Optional


# Mapping van SAE J2735 MovementPhaseState naar een eenvoudige kleur.
# Zie ISO TS 19091 / SAE J2735 voor de volledige semantiek.
PHASE_TO_COLOR: dict[str, str] = {
    "unavailable": "unknown",
    "dark": "dark",
    "stop-Then-Proceed": "red",
    "stop-And-Remain": "red",
    "pre-Movement": "red-amber",
    "permissive-Movement-Allowed": "green",
    "protected-Movement-Allowed": "green",
    "permissive-clearance": "amber",
    "protected-clearance": "amber",
    "caution-Conflicting-Traffic": "amber",
}


@dataclass
class SignalState:
    intersection_id: int
    signal_group: int
    color: str = "unknown"
    phase: str = "unavailable"
    min_end_epoch: Optional[float] = None
    likely_end_epoch: Optional[float] = None
    max_end_epoch: Optional[float] = None
    updated_at: float = field(default_factory=time.time)

    def seconds_until_change(self, now: Optional[float] = None) -> Optional[float]:
        if self.likely_end_epoch is None:
            return None
        now = now if now is not None else time.time()
        return max(0.0, self.likely_end_epoch - now)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["seconds_until_change"] = self.seconds_until_change()
        d["age_seconds"] = max(0.0, time.time() - self.updated_at)
        return d


@dataclass
class IntersectionInfo:
    intersection_id: int
    name: Optional[str] = None
    ref_point: Optional[dict] = None  # {"lat": ..., "lon": ...}
    signal_groups: list[int] = field(default_factory=list)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return asdict(self)


class StateStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._signals: dict[tuple[int, int], SignalState] = {}
        self._intersections: dict[int, IntersectionInfo] = {}

    def update_signal(self, state: SignalState) -> None:
        key = (state.intersection_id, state.signal_group)
        with self._lock:
            self._signals[key] = state

    def update_intersection(self, info: IntersectionInfo) -> None:
        with self._lock:
            self._intersections[info.intersection_id] = info

    def get_signal(self, intersection_id: int, signal_group: int) -> Optional[SignalState]:
        with self._lock:
            return self._signals.get((intersection_id, signal_group))

    def get_intersection(self, intersection_id: int) -> Optional[IntersectionInfo]:
        with self._lock:
            return self._intersections.get(intersection_id)

    def list_intersections(self) -> list[IntersectionInfo]:
        with self._lock:
            return list(self._intersections.values())

    def list_signals(self, intersection_id: Optional[int] = None) -> list[SignalState]:
        with self._lock:
            values = list(self._signals.values())
        if intersection_id is None:
            return values
        return [s for s in values if s.intersection_id == intersection_id]


store = StateStore()
