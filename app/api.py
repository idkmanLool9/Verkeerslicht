"""FastAPI applicatie."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, load_settings
from .demo import DEMO_INTERSECTION_ID, DemoSimulator
from .mqtt_client import UdapMqttClient
from .state import store

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.use_demo:
            log.info("Start in demomodus (gesimuleerd verkeerslicht).")
            sim = DemoSimulator(store)
            sim.start()
            app.state.simulator = sim
            app.state.mqtt = None
        else:
            mqtt_client = UdapMqttClient(settings, store)
            mqtt_client.start()
            app.state.mqtt = mqtt_client
            app.state.simulator = None
        try:
            yield
        finally:
            if app.state.simulator is not None:
                app.state.simulator.stop()
            if app.state.mqtt is not None:
                app.state.mqtt.stop()

    app = FastAPI(title="Verkeerslicht-status", lifespan=lifespan)
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins) or ["*"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "demo_mode": settings.use_demo,
            "broker_configured": settings.has_broker,
        }

    @app.get("/api/intersections")
    def list_intersections() -> dict:
        return {"intersections": [i.to_dict() for i in store.list_intersections()]}

    @app.get("/api/intersections/{intersection_id}")
    def get_intersection(intersection_id: int) -> dict:
        info = store.get_intersection(intersection_id)
        signals = store.list_signals(intersection_id)
        if info is None and not signals:
            raise HTTPException(status_code=404, detail="Onbekende kruising")
        return {
            "intersection": info.to_dict() if info else {"intersection_id": intersection_id},
            "signals": [s.to_dict() for s in signals],
        }

    @app.get("/api/signals/{intersection_id}/{signal_group}")
    def get_signal(intersection_id: int, signal_group: int) -> dict:
        signal = store.get_signal(intersection_id, signal_group)
        if signal is None:
            raise HTTPException(status_code=404, detail="Geen status bekend voor deze signaalgroep")
        return signal.to_dict()

    @app.get("/api/demo")
    def demo_signal() -> dict:
        signal = store.get_signal(DEMO_INTERSECTION_ID, 1)
        if signal is None:
            return JSONResponse(
                {"detail": "Demo nog niet beschikbaar"}, status_code=503
            )
        return signal.to_dict()

    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

        @app.get("/")
        def index():
            return FileResponse(STATIC_DIR / "index.html")

        @app.get("/app.js")
        def app_js():
            return FileResponse(STATIC_DIR / "app.js", media_type="text/javascript")

    return app
