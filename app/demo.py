"""Demosimulator: genereert een gesimuleerd verkeerslicht zonder broker."""

from __future__ import annotations

import threading
import time

from .state import PHASE_TO_COLOR, IntersectionInfo, SignalState, StateStore


# Cyclus: groen 15s, amber 3s, rood 22s. Twee tegengestelde signaalgroepen.
CYCLE = [
    ("permissive-Movement-Allowed", 15.0),
    ("permissive-clearance", 3.0),
    ("stop-And-Remain", 22.0),
]
TOTAL = sum(d for _, d in CYCLE)

DEMO_INTERSECTION_ID = 9999


class DemoSimulator:
    def __init__(self, store: StateStore) -> None:
        self.store = store
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def start(self) -> None:
        self.store.update_intersection(
            IntersectionInfo(
                intersection_id=DEMO_INTERSECTION_ID,
                name="Demo-kruising",
                ref_point={"lat": 52.0907, "lon": 5.1214},
                signal_groups=[1, 2],
            )
        )
        self._thread = threading.Thread(target=self._run, name="demo-sim", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        start = time.time()
        while not self._stop.is_set():
            now = time.time()
            elapsed = (now - start) % TOTAL
            # Bepaal huidige fase voor groep 1
            t = 0.0
            for phase, dur in CYCLE:
                if elapsed < t + dur:
                    remaining = (t + dur) - elapsed
                    self._set(1, phase, now + remaining)
                    # Groep 2 loopt tegengesteld (50% offset)
                    self._set_offset(2, elapsed)
                    break
                t += dur
            time.sleep(0.5)

    def _set(self, sg: int, phase: str, end_epoch: float) -> None:
        self.store.update_signal(
            SignalState(
                intersection_id=DEMO_INTERSECTION_ID,
                signal_group=sg,
                phase=phase,
                color=PHASE_TO_COLOR.get(phase, "unknown"),
                min_end_epoch=end_epoch,
                likely_end_epoch=end_epoch,
                max_end_epoch=end_epoch,
                updated_at=time.time(),
            )
        )

    def _set_offset(self, sg: int, elapsed: float) -> None:
        offset = (elapsed + TOTAL / 2) % TOTAL
        t = 0.0
        for phase, dur in CYCLE:
            if offset < t + dur:
                remaining = (t + dur) - offset
                self._set(sg, phase, time.time() + remaining)
                return
            t += dur
