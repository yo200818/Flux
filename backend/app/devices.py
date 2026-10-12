from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

logger = logging.getLogger(__name__)

DeviceClientType = Literal["desktop", "android", "ios", "web", "pocketdeck_os"]
PAIRING_LIFETIME = timedelta(minutes=3)
PAIRING_CODE_DIGITS = 6
MAX_PENDING_PAIRING_SESSIONS = 128
MAX_PENDING_PAIRING_REQUESTS = 128
PAIRING_ATTEMPTS_PER_MINUTE = 10
MAX_PAIRING_RATE_LIMIT_KEYS = 1024
DEVICE_STORE_PATH_ENV = "POCKETDECK_DEVICE_STORE_PATH"
ADMIN_TOKEN_ENV = "POCKETDECK_ADMIN_TOKEN"


class DeviceStorageError(Exception):
    """Raised when the protected device registry cannot be loaded or saved."""


class DeviceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=48)
    client_type: DeviceClientType

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(
            ord(character) < 32 or ord(character) == 127
            for character in value
        ):
            raise ValueError("Device name must contain printable characters.")
        return value


class DeviceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(pattern=r"^[0-9a-f-]{36}$")
    name: str
    client_type: DeviceClientType
    created_at: datetime
    is_authorized: bool
    is_revoked: bool
    credential_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class DevicePublic(BaseModel):
    device_id: str
    name: str
    client_type: DeviceClientType
    created_at: datetime
    is_authorized: bool
    is_revoked: bool

    @classmethod
    def from_record(cls, record: DeviceRecord) -> DevicePublic:
        return cls(
            device_id=record.device_id,
            name=record.name,
            client_type=record.client_type,
            created_at=record.created_at,
            is_authorized=record.is_authorized,
            is_revoked=record.is_revoked,
        )


@dataclass(frozen=True)
class DeviceCredential:
    device: DevicePublic
    token: str


@dataclass
class _PairingSession:
    session_id: str
    code_hash: str
    expires_at: datetime
    claimed: bool = False


@dataclass
class _PairingRequest:
    request_id: str
    device_id: str
    name: str
    client_type: DeviceClientType
    transport: Literal["wifi", "usb"]
    created_at: datetime
    expires_at: datetime
    status: Literal["pending", "rejected"]


def get_default_device_store_path() -> Path:
    configured_path = os.environ.get(DEVICE_STORE_PATH_ENV)
    if configured_path:
        return Path(configured_path).expanduser()

    app_data = os.environ.get("APPDATA")
    data_directory = (
        Path(app_data)
        if app_data
        else Path.home() / "AppData" / "Roaming"
    )
    return data_directory / "PocketDeck" / "devices.json"


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class DeviceStore:
    """Atomically persist device metadata and hashes of high-entropy tokens."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> dict[str, DeviceRecord]:
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1:
                raise ValueError("Unsupported device registry format.")
            records = [DeviceRecord.model_validate(item) for item in data["devices"]]
            devices = {record.device_id: record for record in records}
            if len(devices) != len(records):
                raise ValueError("Duplicate device ID in registry.")
            return devices
        except (
            OSError,
            UnicodeError,
            json.JSONDecodeError,
            KeyError,
            TypeError,
            ValueError,
            ValidationError,
        ) as error:
            raise DeviceStorageError(
                f"Device registry at '{self.path}' is invalid or unreadable. "
                "It was left unchanged; repair or move it to recover."
            ) from error

    def save(self, devices: dict[str, DeviceRecord]) -> None:
        temporary_path: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                json.dump(
                    {
                        "version": 1,
                        "devices": [
                            record.model_dump(mode="json")
                            for record in devices.values()
                        ],
                    },
                    temporary_file,
                    indent=2,
                )
                temporary_file.write("\n")
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_path, self.path)
        except (OSError, TypeError, ValueError) as error:
            raise DeviceStorageError(
                f"Could not persist device registry at '{self.path}'."
            ) from error
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not remove a temporary device registry file.")


class DeviceRegistry:
    def __init__(self, store: DeviceStore) -> None:
        self._store = store
        self._devices = store.load()
        self._lock = RLock()

    def list_devices(self) -> list[DevicePublic]:
        with self._lock:
            return [
                DevicePublic.from_record(record)
                for record in sorted(
                    self._devices.values(), key=lambda item: item.created_at
                )
            ]

    def add_authorized(
        self,
        device_id: str,
        device_input: DeviceInput,
        created_at: datetime,
    ) -> DeviceCredential:
        token = secrets.token_urlsafe(32)
        record = DeviceRecord(
            device_id=device_id,
            name=device_input.name,
            client_type=device_input.client_type,
            created_at=created_at,
            is_authorized=True,
            is_revoked=False,
            credential_hash=_token_hash(token),
        )
        with self._lock:
            updated = {**self._devices, device_id: record}
            self._store.save(updated)
            self._devices = updated
        logger.info("Authorized PocketDeck device %s.", device_id)
        return DeviceCredential(DevicePublic.from_record(record), token)

    def authenticate(self, token: str) -> DevicePublic | None:
        candidate_hash = _token_hash(token)
        with self._lock:
            for record in self._devices.values():
                if hmac.compare_digest(record.credential_hash, candidate_hash):
                    if record.is_authorized and not record.is_revoked:
                        return DevicePublic.from_record(record)
                    return None
        return None

    def credential_rejection_reason(self, token: str) -> str:
        candidate_hash = _token_hash(token)
        with self._lock:
            for record in self._devices.values():
                if hmac.compare_digest(record.credential_hash, candidate_hash):
                    if record.is_revoked:
                        return "revoked_device"
                    if not record.is_authorized:
                        return "unauthorized_device"
                    return "credential_authentication_failed"
        return "unknown_credential"

    def get(self, device_id: str) -> DevicePublic | None:
        with self._lock:
            record = self._devices.get(device_id)
            return DevicePublic.from_record(record) if record else None

    def revoke(self, device_id: str) -> DevicePublic | None:
        with self._lock:
            record = self._devices.get(device_id)
            if record is None:
                return None
            if record.is_revoked:
                return DevicePublic.from_record(record)
            revoked = record.model_copy(
                update={"is_authorized": False, "is_revoked": True}
            )
            updated = {**self._devices, device_id: revoked}
            self._store.save(updated)
            self._devices = updated
        logger.info("Revoked PocketDeck device %s.", device_id)
        return DevicePublic.from_record(revoked)


class PairingManager:
    def __init__(
        self,
        registry: DeviceRegistry,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._registry = registry
        self._clock = clock
        self._sessions: dict[str, _PairingSession] = {}
        self._requests: dict[str, _PairingRequest] = {}
        self._claim_attempts: dict[str, tuple[datetime, int]] = {}
        self._lock = RLock()

    def create_session(self) -> tuple[str, str, datetime]:
        with self._lock:
            self._cleanup_expired()
            if len(self._sessions) >= MAX_PENDING_PAIRING_SESSIONS:
                raise PairingError(
                    "pairing_capacity_reached",
                    "Too many pairing sessions are pending. Try again shortly.",
                    429,
                )
            active_codes = {session.code_hash for session in self._sessions.values()}
            while True:
                pairing_code = f"{secrets.randbelow(10 ** PAIRING_CODE_DIGITS):0{PAIRING_CODE_DIGITS}d}"
                code_hash = _token_hash(pairing_code)
                if code_hash not in active_codes:
                    break
            session_id = str(uuid4())
            expires_at = self._clock() + PAIRING_LIFETIME
            self._sessions[session_id] = _PairingSession(
                session_id=session_id,
                code_hash=code_hash,
                expires_at=expires_at,
            )
        return session_id, pairing_code, expires_at

    def claim(
        self,
        pairing_code: str,
        device_input: DeviceInput,
        *,
        client_key: str = "unknown",
    ) -> _PairingRequest:
        code_hash = _token_hash(pairing_code)
        with self._lock:
            now = self._record_claim_attempt(client_key)
            self._cleanup_expired()
            session = next(
                (
                    item
                    for item in self._sessions.values()
                    if hmac.compare_digest(item.code_hash, code_hash)
                ),
                None,
            )
            if session is None:
                raise PairingError(
                    "invalid_pairing_code",
                    "Pairing code is invalid or expired.",
                    404,
                )
            if session.claimed:
                raise PairingError(
                    "pairing_code_used",
                    "Pairing code has already been used.",
                    409,
                )
            session.claimed = True
            if len(self._requests) >= MAX_PENDING_PAIRING_REQUESTS:
                session.claimed = False
                raise PairingError(
                    "pairing_capacity_reached",
                    "Too many pairing requests are pending. Try again shortly.",
                    429,
                )
            request = self._create_request(
                device_input,
                now,
                session.expires_at,
                "wifi",
            )
        logger.info("Received a Wi-Fi device pairing request %s.", request.request_id)
        return request

    def claim_usb(
        self,
        device_input: DeviceInput,
        *,
        client_key: str,
    ) -> _PairingRequest:
        with self._lock:
            now = self._record_claim_attempt(client_key)
            self._cleanup_expired()
            request = self._create_request(
                device_input,
                now,
                now + PAIRING_LIFETIME,
                "usb",
            )
        logger.info("Received a USB device pairing request %s.", request.request_id)
        return request

    def _record_claim_attempt(self, client_key: str) -> datetime:
        now = self._clock()
        window_start, attempts = self._claim_attempts.get(client_key, (now, 0))
        if (
            client_key not in self._claim_attempts
            and len(self._claim_attempts) >= MAX_PAIRING_RATE_LIMIT_KEYS
        ):
            raise PairingError(
                "pairing_rate_limited",
                "Pairing is temporarily busy. Try again shortly.",
                429,
            )
        if now - window_start >= timedelta(minutes=1):
            window_start, attempts = now, 0
        if attempts >= PAIRING_ATTEMPTS_PER_MINUTE:
            raise PairingError(
                "pairing_rate_limited",
                "Too many pairing attempts. Wait one minute and try again.",
                429,
            )
        self._claim_attempts[client_key] = (window_start, attempts + 1)
        return now

    def _create_request(
        self,
        device_input: DeviceInput,
        now: datetime,
        expires_at: datetime,
        transport: Literal["wifi", "usb"],
    ) -> _PairingRequest:
        if len(self._requests) >= MAX_PENDING_PAIRING_REQUESTS:
            raise PairingError(
                "pairing_capacity_reached",
                "Too many pairing requests are pending. Try again shortly.",
                429,
            )
        request = _PairingRequest(
            request_id=str(uuid4()),
            device_id=str(uuid4()),
            name=device_input.name,
            client_type=device_input.client_type,
            transport=transport,
            created_at=now,
            expires_at=expires_at,
            status="pending",
        )
        self._requests[request.request_id] = request
        return request

    def list_pending(self) -> list[_PairingRequest]:
        with self._lock:
            self._cleanup_expired()
            return [
                request
                for request in self._requests.values()
                if request.status == "pending"
            ]

    def approve(self, request_id: str) -> DeviceCredential:
        with self._lock:
            self._cleanup_expired()
            request = self._requests.get(request_id)
            if request is None:
                raise PairingError(
                    "pairing_request_not_found",
                    "Pairing request was not found or has expired.",
                    404,
                )
            if request.status != "pending":
                raise PairingError(
                    "pairing_request_closed",
                    "Pairing request is no longer pending.",
                    409,
                )
            credential = self._registry.add_authorized(
                request.device_id,
                DeviceInput(name=request.name, client_type=request.client_type),
                self._clock(),
            )
            del self._requests[request_id]
        logger.info("Approved device pairing request %s.", request_id)
        return credential

    def reject(self, request_id: str) -> None:
        with self._lock:
            self._cleanup_expired()
            request = self._requests.get(request_id)
            if request is None:
                raise PairingError(
                    "pairing_request_not_found",
                    "Pairing request was not found or has expired.",
                    404,
                )
            if request.status != "pending":
                raise PairingError(
                    "pairing_request_closed",
                    "Pairing request is no longer pending.",
                    409,
                )
            request.status = "rejected"
        logger.info("Rejected device pairing request %s.", request_id)

    def _cleanup_expired(self) -> None:
        now = self._clock()
        expired_sessions = [
            session_id
            for session_id, session in self._sessions.items()
            if session.expires_at <= now
        ]
        for session_id in expired_sessions:
            del self._sessions[session_id]
        expired_requests = [
            request_id
            for request_id, request in self._requests.items()
            if request.expires_at <= now
        ]
        for request_id in expired_requests:
            del self._requests[request_id]
        expired_attempts = [
            client_key
            for client_key, (window_start, _) in self._claim_attempts.items()
            if now - window_start >= timedelta(minutes=1)
        ]
        for client_key in expired_attempts:
            del self._claim_attempts[client_key]


class PairingError(Exception):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": str(self)}
