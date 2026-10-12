from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import socket
import ssl
import tempfile
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID, uuid4

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

WIFI_ENABLED_ENV = "POCKETDECK_ENABLE_WIFI"
WIFI_PORT_ENV = "POCKETDECK_WIFI_PORT"
WIFI_PORT = 8443
WIFI_IDENTITY_FILENAME = "wifi-identity.json"
_DPAPI_PREFIX = b"PocketDeck-DPAPI\x00"


@dataclass(frozen=True)
class WindowsIdentity:
    server_id: str
    config_epoch: str
    migration_namespace: str


@dataclass(frozen=True)
class WifiTlsIdentity:
    certificate_path: Path
    private_key_path: Path
    fingerprint: str
    expires_at_epoch_seconds: int


def load_or_create_windows_identity(path: Path) -> WindowsIdentity:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        identity = WindowsIdentity(
            server_id=str(UUID(value["server_id"])),
            config_epoch=str(UUID(value["config_epoch"])),
            migration_namespace=str(UUID(value["migration_namespace"])),
        )
        return identity
    except FileNotFoundError:
        identity = WindowsIdentity(
            server_id=str(uuid4()),
            config_epoch=str(uuid4()),
            migration_namespace=str(uuid4()),
        )
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise RuntimeError(
            f"PocketDeck Wi-Fi identity at '{path}' is invalid; refusing to change it."
        ) from error

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(identity.__dict__, temporary_file)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return identity


def _local_ip_addresses() -> list[ipaddress.IPv4Address]:
    addresses: set[ipaddress.IPv4Address] = set()
    try:
        for result in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = ipaddress.ip_address(result[4][0])
            if (
                isinstance(address, ipaddress.IPv4Address)
                and address.is_private
                and not address.is_loopback
                and not address.is_link_local
                and not address.is_multicast
                and not address.is_unspecified
                and not address.is_reserved
            ):
                addresses.add(address)
    except OSError:
        return []
    return sorted(addresses)


def wifi_bind_addresses() -> list[str]:
    addresses = ["127.0.0.1"]
    if wifi_enabled():
        addresses.extend(
            str(address)
            for address in _local_ip_addresses()
            if address.is_private
            and not address.is_loopback
            and not address.is_link_local
            and not address.is_multicast
            and not address.is_unspecified
            and not address.is_reserved
        )
    return addresses


def bind_wifi_sockets(port: int, *, include_lan: bool = True) -> list[socket.socket]:
    addresses = wifi_bind_addresses() if include_lan else ["127.0.0.1"]
    listeners: list[socket.socket] = []
    try:
        for address in addresses:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                listener.bind((address, port))
                listener.listen(socket.SOMAXCONN)
                listener.setblocking(False)
            except OSError:
                listener.close()
                raise
            listeners.append(listener)
    except OSError:
        for listener in listeners:
            listener.close()
        raise
    return listeners


def ensure_wifi_tls_identity(directory: Path) -> WifiTlsIdentity:
    certificate_path = directory / "wifi-cert.pem"
    private_key_path = directory / "wifi-key.pem"
    if certificate_path.exists() or private_key_path.exists():
        try:
            certificate = x509.load_pem_x509_certificate(
                certificate_path.read_bytes()
            )
            private_key_bytes = _unprotect_private_key(private_key_path.read_bytes())
            private_key = serialization.load_pem_private_key(private_key_bytes, None)
            certificate_public_key = certificate.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            private_public_key = private_key.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            if not hashlib.sha256(certificate_public_key).digest() == hashlib.sha256(
                private_public_key
            ).digest():
                raise ValueError("TLS certificate and private key do not match.")
            if os.name == "nt" and not private_key_path.read_bytes().startswith(
                _DPAPI_PREFIX
            ):
                _write_private_key(private_key_path, private_key_bytes)
        except (OSError, ValueError, TypeError) as error:
            raise RuntimeError(
                "PocketDeck's Wi-Fi TLS certificate is incomplete or invalid; "
                "the Wi-Fi listener was not started."
            ) from error
    else:
        directory.mkdir(parents=True, exist_ok=True)
        private_key = ec.generate_private_key(ec.SECP256R1())
        now = datetime.now(timezone.utc)
        subject = x509.Name(
            [x509.NameAttribute(NameOID.COMMON_NAME, "PocketDeck Windows host")]
        )
        sans: list[x509.GeneralName] = [
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        ]
        sans.extend(x509.IPAddress(address) for address in _local_ip_addresses())
        certificate = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(subject)
            .public_key(private_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(private_key, hashes.SHA256())
        )
        private_key_bytes = private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        _write_private_key(private_key_path, private_key_bytes)
        certificate_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))

    fingerprint = certificate.fingerprint(hashes.SHA256()).hex().upper()
    fingerprint = ":".join(
        fingerprint[index : index + 2] for index in range(0, len(fingerprint), 2)
    )
    return WifiTlsIdentity(
        certificate_path,
        private_key_path,
        fingerprint,
        int(certificate.not_valid_after_utc.timestamp()),
    )


def wifi_enabled() -> bool:
    return os.environ.get(WIFI_ENABLED_ENV) == "1"


def wifi_port() -> int:
    raw_port = os.environ.get(WIFI_PORT_ENV, str(WIFI_PORT))
    try:
        port = int(raw_port)
    except ValueError as error:
        raise RuntimeError(f"{WIFI_PORT_ENV} must be a valid TCP port.") from error
    if not 1 <= port <= 65535:
        raise RuntimeError(f"{WIFI_PORT_ENV} must be a valid TCP port.")
    return port


def wifi_tls_context(identity: WifiTlsIdentity) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    private_key = _unprotect_private_key(identity.private_key_path.read_bytes())
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=identity.private_key_path.parent,
            prefix=".wifi-key-",
            suffix=".pem",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(private_key)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        if os.name != "nt":
            temporary_path.chmod(0o600)
        context.load_cert_chain(identity.certificate_path, temporary_path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return context


def _write_private_key(path: Path, private_key: bytes) -> None:
    encoded = (
        _DPAPI_PREFIX + _dpapi_protect(private_key)
        if os.name == "nt"
        else private_key
    )
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(encoded)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        if os.name != "nt":
            temporary_path.chmod(0o600)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _unprotect_private_key(encoded: bytes) -> bytes:
    if encoded.startswith(_DPAPI_PREFIX):
        if os.name != "nt":
            raise ValueError("Windows-protected TLS key cannot be opened on this platform.")
        return _dpapi_unprotect(encoded[len(_DPAPI_PREFIX) :])
    return encoded


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _dpapi_transform(data: bytes, *, protect: bool) -> bytes:
    if os.name != "nt":
        raise RuntimeError("Windows DPAPI is only available on Windows.")
    source_buffer = ctypes.create_string_buffer(data)
    source = _DataBlob(
        len(data),
        ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_byte)),
    )
    result = _DataBlob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    transform = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    transform.argtypes = [
        ctypes.POINTER(_DataBlob),
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(_DataBlob),
    ]
    transform.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if not transform(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        kernel32.LocalFree(result.pbData)


def _dpapi_protect(data: bytes) -> bytes:
    return _dpapi_transform(data, protect=True)


def _dpapi_unprotect(data: bytes) -> bytes:
    return _dpapi_transform(data, protect=False)
 