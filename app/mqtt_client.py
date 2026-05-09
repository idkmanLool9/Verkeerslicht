"""MQTT-client voor de UDAP / Talking Traffic broker."""

from __future__ import annotations

import logging
import ssl
import threading
from typing import Optional

import paho.mqtt.client as mqtt

from .config import Settings
from .decoder import parse_map_payload, parse_spat_payload
from .state import StateStore

log = logging.getLogger(__name__)


class UdapMqttClient:
    def __init__(self, settings: Settings, store: StateStore) -> None:
        self.settings = settings
        self.store = store
        self._client: Optional[mqtt.Client] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> None:
        if not self.settings.has_broker:
            log.info("Geen UDAP broker geconfigureerd; MQTT-client wordt niet gestart.")
            return

        client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id="",
            clean_session=True,
        )
        client.username_pw_set(self.settings.udap_username, self.settings.udap_password)
        if self.settings.udap_use_tls:
            client.tls_set(cert_reqs=ssl.CERT_REQUIRED)

        client.on_connect = self._on_connect
        client.on_message = self._on_message
        client.on_disconnect = self._on_disconnect

        log.info(
            "Verbinden met UDAP broker %s:%d (tls=%s)",
            self.settings.udap_host,
            self.settings.udap_port,
            self.settings.udap_use_tls,
        )
        client.connect_async(self.settings.udap_host, self.settings.udap_port, keepalive=60)
        client.loop_start()
        self._client = client

    def stop(self) -> None:
        self._stop.set()
        if self._client is not None:
            self._client.loop_stop()
            self._client.disconnect()

    # --- callbacks ---
    def _on_connect(self, client: mqtt.Client, userdata, flags, reason_code, properties=None):
        if reason_code != 0:
            log.error("MQTT-verbinding mislukt: %s", reason_code)
            return
        for topic in (self.settings.udap_spat_topic, self.settings.udap_map_topic):
            log.info("Abonneren op %s", topic)
            client.subscribe(topic, qos=0)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        log.warning("MQTT-verbinding verbroken (reason=%s)", reason_code)

    def _on_message(self, client, userdata, msg):
        topic = msg.topic
        payload = msg.payload
        try:
            if "SPATEM" in topic or "spat" in topic.lower():
                for state in parse_spat_payload(payload):
                    self.store.update_signal(state)
            elif "MAPEM" in topic or "map" in topic.lower():
                info = parse_map_payload(payload)
                if info is not None:
                    self.store.update_intersection(info)
        except Exception:  # pragma: no cover - defensief
            log.exception("Fout bij verwerken bericht op topic %s", topic)
