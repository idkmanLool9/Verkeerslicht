import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    udap_host: str
    udap_port: int
    udap_username: str
    udap_password: str
    udap_use_tls: bool
    udap_spat_topic: str
    udap_map_topic: str
    host: str
    port: int
    demo_mode: bool
    cors_origins: tuple[str, ...]

    @property
    def has_broker(self) -> bool:
        return bool(self.udap_host and self.udap_username and self.udap_password)

    @property
    def use_demo(self) -> bool:
        return self.demo_mode or not self.has_broker


def load_settings() -> Settings:
    raw_origins = os.getenv("CORS_ORIGINS", "*").strip()
    origins = tuple(o.strip() for o in raw_origins.split(",") if o.strip())
    return Settings(
        udap_host=os.getenv("UDAP_HOST", "").strip(),
        udap_port=int(os.getenv("UDAP_PORT", "8883")),
        udap_username=os.getenv("UDAP_USERNAME", "").strip(),
        udap_password=os.getenv("UDAP_PASSWORD", "").strip(),
        udap_use_tls=_bool("UDAP_USE_TLS", True),
        udap_spat_topic=os.getenv("UDAP_SPAT_TOPIC", "topicroot/+/+/SPATEM/#"),
        udap_map_topic=os.getenv("UDAP_MAP_TOPIC", "topicroot/+/+/MAPEM/#"),
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        demo_mode=_bool("DEMO_MODE", False),
        cors_origins=origins,
    )
