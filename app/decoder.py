"""Decoder voor SPaT/MAP-berichten van Talking Traffic / UDAP.

De UDAP MQTT-feed publiceert standaard UPER-encoded ASN.1 (SAE J2735 /
ISO TS 19091). Sommige abonnementen leveren een JSON-interpretatie aan op
parallelle topics. Deze decoder is tolerant: we proberen JSON, en zo niet,
geven we een duidelijke melding dat een ASN.1-decoder nodig is.
"""

from __future__ import annotations

import json
import time
from typing import Any, Iterable, Optional

from .state import PHASE_TO_COLOR, IntersectionInfo, SignalState


def _first(d: dict, *keys: str, default: Any = None) -> Any:
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def _phase_name(value: Any) -> str:
    """Normaliseer eventState naar SAE J2735 naam."""
    if isinstance(value, str):
        return value
    # Numerieke MovementPhaseState (SAE J2735)
    table = [
        "unavailable",
        "dark",
        "stop-Then-Proceed",
        "stop-And-Remain",
        "pre-Movement",
        "permissive-Movement-Allowed",
        "protected-Movement-Allowed",
        "permissive-clearance",
        "protected-clearance",
        "caution-Conflicting-Traffic",
    ]
    try:
        return table[int(value)]
    except (ValueError, TypeError, IndexError):
        return "unavailable"


def _tenths_to_epoch(tenths: Optional[int], now: Optional[float] = None) -> Optional[float]:
    """SAE J2735 TimeMark: tienden van seconden binnen het huidige uur (0..36000).

    36001 = onbekend, 36002 = direct na nu, 36011 = nooit.
    We mappen onbekende waarden naar None en lossen de wrap rond het uur op
    door een toekomstwaarde te kiezen die binnen het volgende uur ligt.
    """
    if tenths is None:
        return None
    try:
        t = int(tenths)
    except (ValueError, TypeError):
        return None
    if t >= 36001:
        return None
    now = now if now is not None else time.time()
    hour_start = now - (now % 3600)
    candidate = hour_start + t / 10.0
    if candidate < now - 1800:
        candidate += 3600
    return candidate


def _parse_timing(timing: dict, now: Optional[float] = None) -> dict:
    return {
        "min_end_epoch": _tenths_to_epoch(
            _first(timing, "minEndTime", "min-end-time", "minEnd"), now
        ),
        "likely_end_epoch": _tenths_to_epoch(
            _first(timing, "likelyTime", "likely-time", "minEndTime", "min-end-time"), now
        ),
        "max_end_epoch": _tenths_to_epoch(
            _first(timing, "maxEndTime", "max-end-time", "maxEnd"), now
        ),
    }


def parse_spat_payload(payload: bytes) -> list[SignalState]:
    """Probeer een SPaT-payload te parsen. Geeft lege lijst bij onbekend formaat."""
    data = _try_json(payload)
    if data is None:
        return []

    # Sommige interpreters wrappen in {"spat": {...}} of {"intersections":[...]}.
    intersections = (
        _first(data, "intersections")
        or _first(data, "intersectionStateList")
        or _first(data, "states") and [data]
        or [data]
    )
    if isinstance(intersections, dict):
        intersections = [intersections]

    results: list[SignalState] = []
    now = time.time()
    for ix in intersections:
        if not isinstance(ix, dict):
            continue
        ix_id = _first(ix, "intersectionId", "intersection-id", "id")
        if ix_id is None:
            continue
        try:
            ix_id = int(ix_id)
        except (ValueError, TypeError):
            continue

        states = _first(ix, "states", "movementList") or []
        for movement in states:
            if not isinstance(movement, dict):
                continue
            sg = _first(movement, "signalGroup", "signal-group", "signalGroupId")
            if sg is None:
                continue
            try:
                sg = int(sg)
            except (ValueError, TypeError):
                continue

            timings = _first(movement, "state-time-speed", "stateTimeSpeed") or []
            if not timings:
                continue
            current = timings[0] if isinstance(timings, list) else timings
            phase = _phase_name(_first(current, "eventState", "state", "event-state"))
            timing = _first(current, "timing", default={}) or {}
            t = _parse_timing(timing, now)

            results.append(
                SignalState(
                    intersection_id=ix_id,
                    signal_group=sg,
                    phase=phase,
                    color=PHASE_TO_COLOR.get(phase, "unknown"),
                    min_end_epoch=t["min_end_epoch"],
                    likely_end_epoch=t["likely_end_epoch"],
                    max_end_epoch=t["max_end_epoch"],
                    updated_at=now,
                )
            )
    return results


def parse_map_payload(payload: bytes) -> Optional[IntersectionInfo]:
    """Parse een MAP-payload (statische topologie van een kruising)."""
    data = _try_json(payload)
    if data is None:
        return None

    intersections = _first(data, "intersections") or [data]
    if isinstance(intersections, dict):
        intersections = [intersections]

    for ix in intersections:
        if not isinstance(ix, dict):
            continue
        ix_id = _first(ix, "intersectionId", "intersection-id", "id")
        try:
            ix_id = int(ix_id) if ix_id is not None else None
        except (ValueError, TypeError):
            ix_id = None
        if ix_id is None:
            continue
        ref = _first(ix, "refPoint", "ref-point", default={}) or {}
        # J2735: lat/lon in micro-graden (1e-7), height in decimeters
        lat = ref.get("lat")
        lon = ref.get("long") or ref.get("lon")
        ref_point = None
        if lat is not None and lon is not None:
            try:
                ref_point = {"lat": int(lat) / 1e7, "lon": int(lon) / 1e7}
            except (ValueError, TypeError):
                ref_point = None

        signal_groups: list[int] = []
        lanes = _first(ix, "laneSet", "lane-set") or []
        for lane in lanes:
            if not isinstance(lane, dict):
                continue
            connects = _first(lane, "connectsTo", "connects-to") or []
            for c in connects:
                sg = _first(c, "signalGroup", "signal-group")
                if sg is not None:
                    try:
                        signal_groups.append(int(sg))
                    except (ValueError, TypeError):
                        pass
        return IntersectionInfo(
            intersection_id=ix_id,
            name=_first(ix, "name"),
            ref_point=ref_point,
            signal_groups=sorted(set(signal_groups)),
        )
    return None


def _try_json(payload: bytes) -> Optional[Any]:
    if not payload:
        return None
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
