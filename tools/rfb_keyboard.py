#!/usr/bin/env python3
"""Send bounded keyboard input to a local, unauthenticated RFB console.

This is a diagnostic helper for the QEMU console inside the managed node
network namespace.  It intentionally implements only the RFB 3.8 handshake
with the None security type and keyboard events; it does not render or expose
the guest display.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import socket
import struct
import tempfile
import time


SPECIAL = {
    "enter": 0xFF0D,
    "tab": 0xFF09,
    "escape": 0xFF1B,
    "backspace": 0xFF08,
    "delete": 0xFFFF,
    "insert": 0xFF63,
    "up": 0xFF52,
    "down": 0xFF54,
    "left": 0xFF51,
    "right": 0xFF53,
    "shift": 0xFFE1,
    "control": 0xFFE3,
    "alt": 0xFFE9,
    "super": 0xFFEB,
    "menu": 0xFF67,
    "capslock": 0xFFE5,
    "space": 0x20,
    "f10": 0xFFC7,
    "f4": 0xFFC1,
}

XT_SCANCODE = {
    **{
        character: code
        for character, code in zip(
            "1234567890",
            (0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B),
        )
    },
    **dict(
        zip(
            "abcdefghijklmnopqrstuvwxyz",
            (
                0x1E,
                0x30,
                0x2E,
                0x20,
                0x12,
                0x21,
                0x22,
                0x23,
                0x17,
                0x24,
                0x25,
                0x26,
                0x32,
                0x31,
                0x18,
                0x19,
                0x10,
                0x13,
                0x1F,
                0x14,
                0x16,
                0x2F,
                0x11,
                0x2D,
                0x15,
                0x2C,
            ),
        )
    ),
    " ": 0x39,
    "-": 0x0C,
    "=": 0x0D,
    "[": 0x1A,
    "]": 0x1B,
    "\\": 0x2B,
    ";": 0x27,
    "'": 0x28,
    "`": 0x29,
    ",": 0x33,
    ".": 0x34,
    "/": 0x35,
}

XT_SPECIAL = {
    "enter": (0xFF0D, 0x1C),
    "tab": (0xFF09, 0x0F),
    "escape": (0xFF1B, 0x01),
    "backspace": (0xFF08, 0x0E),
    "shift": (0xFFE1, 0x2A),
    "control": (0xFFE3, 0x1D),
    "alt": (0xFFE9, 0x38),
    "super": (0xFFEB, 0xE05B),
    "menu": (0xFF67, 0xE05D),
    "capslock": (0xFFE5, 0x3A),
    "space": (0x20, 0x39),
    "f4": (0xFFC1, 0x3E),
    "f10": (0xFFC7, 0x44),
    "up": (0xFF52, 0xE048),
    "left": (0xFF51, 0xE04B),
    "right": (0xFF53, 0xE04D),
    "down": (0xFF54, 0xE050),
}


def exact(sock: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise RuntimeError("RFB connection closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def connect(host: str, port: int, timeout: float) -> tuple[socket.socket, int, int]:
    sock = socket.create_connection((host, port), timeout)
    sock.settimeout(timeout)
    version = exact(sock, 12)
    if not version.startswith(b"RFB 003."):
        raise RuntimeError("Unsupported RFB greeting")
    sock.sendall(b"RFB 003.008\n")
    count = exact(sock, 1)[0]
    security = exact(sock, count)
    if 1 not in security:
        raise RuntimeError("RFB console requires unsupported authentication")
    sock.sendall(b"\x01")
    if struct.unpack(">I", exact(sock, 4))[0] != 0:
        raise RuntimeError("RFB security negotiation failed")
    sock.sendall(b"\x01")  # shared session
    header = exact(sock, 24)
    exact(sock, struct.unpack(">I", header[20:24])[0])
    width, height = struct.unpack(">HH", header[:4])
    return sock, width, height


def event(sock: socket.socket, keysym: int, down: bool) -> None:
    sock.sendall(struct.pack(">BBHI", 4, int(down), 0, keysym))


def enable_extended_keys(
    sock: socket.socket, width: int, height: int, timeout: float
) -> None:
    sock.settimeout(timeout)
    sock.sendall(struct.pack(">BBHi", 2, 0, 1, -258))
    sock.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, width, height))
    while True:
        message_type = exact(sock, 1)[0]
        if message_type == 0:
            rectangle_count = struct.unpack(">H", exact(sock, 3)[1:])[0]
            for _ in range(rectangle_count):
                _, _, rect_width, rect_height, encoding = struct.unpack(
                    ">HHHHi", exact(sock, 12)
                )
                if encoding == -258:
                    return
                if encoding == 0:
                    exact(sock, rect_width * rect_height * 4)
                    continue
                raise RuntimeError(
                    f"Unexpected RFB encoding while enabling keys: {encoding}"
                )
        elif message_type == 2:
            continue
        elif message_type == 3:
            exact(sock, 3)
            exact(sock, struct.unpack(">I", exact(sock, 4))[0])
        else:
            raise RuntimeError(
                f"Unexpected RFB message while enabling keys: {message_type}"
            )


def extended_event(
    sock: socket.socket, keysym: int, keycode: int, down: bool
) -> None:
    sock.sendall(struct.pack(">BBHII", 255, 0, int(down), keysym, keycode))


def extended_press(
    sock: socket.socket, keysym: int, keycode: int, interval: float
) -> None:
    extended_event(sock, keysym, keycode, True)
    time.sleep(interval)
    extended_event(sock, keysym, keycode, False)
    time.sleep(interval)


def physical_key(sock: socket.socket, name: str, interval: float) -> None:
    keysym, keycode = XT_SPECIAL[name]
    extended_press(sock, keysym, keycode, interval)


def physical_chord(sock: socket.socket, names: str, interval: float) -> None:
    keys = [name.strip().lower() for name in names.split("+") if name.strip()]
    if len(keys) < 2 or any(
        name not in XT_SPECIAL and name not in XT_SCANCODE for name in keys
    ):
        raise ValueError("Physical chord must contain known keys joined with +")
    for name in keys:
        if name in XT_SPECIAL:
            extended_event(sock, *XT_SPECIAL[name], True)
        else:
            extended_event(sock, ord(name), XT_SCANCODE[name], True)
    time.sleep(interval)
    for name in reversed(keys):
        if name in XT_SPECIAL:
            extended_event(sock, *XT_SPECIAL[name], False)
        else:
            extended_event(sock, ord(name), XT_SCANCODE[name], False)
    time.sleep(interval)


def physical_text(sock: socket.socket, value: str, interval: float) -> None:
    shifted = {
        "!": "1",
        ":": ";",
        "#": "3",
        "$": "4",
        "%": "5",
        "^": "6",
        "&": "7",
        "*": "8",
        "(": "9",
        ")": "0",
        "?": "/",
        "_": "-",
        "+": "=",
        "@": "2",
        '"': "'",
    }
    for character in value:
        base = character.lower()
        needs_shift = character.isupper() or character in shifted
        if character in shifted:
            base = shifted[character]
        if base not in XT_SCANCODE:
            raise ValueError(f"Unsupported physical character: {character!r}")
        if needs_shift:
            extended_event(sock, *XT_SPECIAL["shift"], True)
        extended_press(sock, ord(character), XT_SCANCODE[base], interval)
        if needs_shift:
            extended_event(sock, *XT_SPECIAL["shift"], False)


def press(sock: socket.socket, keysym: int, interval: float) -> None:
    event(sock, keysym, True)
    time.sleep(interval)
    event(sock, keysym, False)
    time.sleep(interval)


def click(
    sock: socket.socket,
    coordinate: str,
    width: int,
    height: int,
    button_mask: int = 1,
) -> None:
    try:
        x_text, y_text = coordinate.split(",", 1)
        x, y = int(x_text), int(y_text)
    except (TypeError, ValueError) as error:
        raise ValueError("Click must be formatted as x,y") from error
    if not 0 <= x < width or not 0 <= y < height:
        raise ValueError("Click is outside the framebuffer")
    sock.sendall(struct.pack(">BBHH", 5, 0, x, y))
    # OOBE's XAML controls occasionally treat an ultra-short VNC button pulse
    # as focus-only input.  Keep the button down long enough to be recognised
    # as a normal click while remaining well below a long-press gesture.
    time.sleep(0.15)
    sock.sendall(struct.pack(">BBHH", 5, button_mask, x, y))
    time.sleep(0.15)
    sock.sendall(struct.pack(">BBHH", 5, 0, x, y))
    # Do not tear down the short-lived diagnostic connection before QEMU has
    # dispatched the release to the guest.  Losing the release makes XAML
    # controls show focus without invoking their click action.
    time.sleep(0.15)


def chord(sock: socket.socket, names: str, interval: float) -> None:
    keys = [name.strip().lower() for name in names.split("+") if name.strip()]
    if len(keys) < 2 or any(name not in SPECIAL and len(name) != 1 for name in keys):
        raise ValueError("Chord must contain known keys joined with +")
    for name in keys:
        event(sock, SPECIAL[name] if name in SPECIAL else ord(name), True)
    time.sleep(interval)
    for name in reversed(keys):
        event(sock, SPECIAL[name] if name in SPECIAL else ord(name), False)
    time.sleep(interval)


def clipboard(sock: socket.socket, value: str) -> None:
    payload = value.encode("latin-1")
    sock.sendall(b"\x06\x00\x00\x00" + struct.pack(">I", len(payload)) + payload)


def text(sock: socket.socket, value: str, interval: float) -> None:
    shifted = {
        ":": ";",
        "?": "/",
        "_": "-",
        "+": "=",
        "@": "2",
    }
    for character in value:
        if not 0x20 <= ord(character) <= 0x7E:
            raise ValueError("Only printable ASCII text is supported")
        if "A" <= character <= "Z":
            event(sock, SPECIAL["shift"], True)
            press(sock, ord(character.lower()), interval)
            event(sock, SPECIAL["shift"], False)
        elif character in shifted:
            event(sock, SPECIAL["shift"], True)
            press(sock, ord(shifted[character]), interval)
            event(sock, SPECIAL["shift"], False)
        else:
            press(sock, ord(character), interval)


def screenshot(sock: socket.socket, width: int, height: int, output: str) -> None:
    # Request little-endian 32-bit true color with one raw rectangle.  This
    # avoids dependency on any VNC rendering library and keeps the diagnostic
    # path independent of Guacamole.
    pixel_format = struct.pack(
        ">BBBBHHHBBBxxx",
        32,
        24,
        0,
        1,
        255,
        255,
        255,
        16,
        8,
        0,
    )
    sock.sendall(b"\x00\x00\x00\x00" + pixel_format)
    sock.sendall(struct.pack(">BBHi", 2, 0, 1, 0))  # raw encoding only
    sock.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, width, height))

    while True:
        message_type = exact(sock, 1)[0]
        if message_type == 0:  # FramebufferUpdate
            rectangle_count = struct.unpack(">H", exact(sock, 3)[1:])[0]
            canvas = bytearray(width * height * 3)
            for _ in range(rectangle_count):
                x, y, rect_width, rect_height, encoding = struct.unpack(
                    ">HHHHi", exact(sock, 12)
                )
                if encoding != 0:
                    raise RuntimeError(f"Unexpected RFB encoding {encoding}")
                pixels = exact(sock, rect_width * rect_height * 4)
                for row in range(rect_height):
                    for column in range(rect_width):
                        source = (row * rect_width + column) * 4
                        destination = ((y + row) * width + x + column) * 3
                        blue, green, red = pixels[source : source + 3]
                        canvas[destination : destination + 3] = bytes((red, green, blue))
            with open(output, "wb") as image:
                image.write(f"P6\n{width} {height}\n255\n".encode())
                image.write(canvas)
            return
        if message_type == 2:  # Bell
            continue
        if message_type == 3:  # ServerCutText
            exact(sock, 3)
            exact(sock, struct.unpack(">I", exact(sock, 4))[0])
            continue
        raise RuntimeError(f"Unexpected RFB server message {message_type}")


def captured_screen(host: str, port: int, timeout: float) -> bytes:
    """Capture one framebuffer as bounded PPM bytes for exact recovery gating."""
    fd, path = tempfile.mkstemp(prefix="teamaibox-rfb-", suffix=".ppm")
    os.close(fd)
    try:
        probe, width, height = connect(host, port, timeout)
        with probe:
            screenshot(probe, width, height, path)
        with open(path, "rb") as image:
            return image.read()
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def boot_selected_cd_if_prompt(
    sock: socket.socket,
    host: str,
    port: int,
    timeout: float,
    interval: float,
    expected_menu_sha256: str,
    expected_prompt_sha256: str,
) -> None:
    """Boot the selected UEFI USB media only when both screens are exact."""
    menu_digest = hashlib.sha256(captured_screen(host, port, timeout)).hexdigest()
    if menu_digest != expected_menu_sha256:
        raise RuntimeError("Boot Manager framebuffer does not match the approved screen")
    press(sock, SPECIAL["enter"], interval)
    deadline = time.monotonic() + 4.5
    while time.monotonic() < deadline:
        prompt_digest = hashlib.sha256(captured_screen(host, port, timeout)).hexdigest()
        if prompt_digest == expected_prompt_sha256:
            press(sock, SPECIAL["space"], interval)
            return
        time.sleep(0.05)
    raise RuntimeError("CD/DVD boot prompt was not observed; no key was sent")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--text", default="")
    parser.add_argument("--clipboard")
    parser.add_argument("--physical-text")
    parser.add_argument("--oobe-command")
    parser.add_argument("--active-command")
    parser.add_argument(
        "--physical-key", action="append", choices=sorted(XT_SPECIAL), default=[]
    )
    parser.add_argument("--physical-chord", action="append", default=[])
    parser.add_argument("--key", action="append", choices=sorted(SPECIAL), default=[])
    parser.add_argument("--click", action="append", default=[])
    parser.add_argument("--right-click", action="append", default=[])
    parser.add_argument("--chord", action="append", default=[])
    parser.add_argument("--screenshot")
    parser.add_argument("--boot-selected-cd-if-prompt", action="store_true")
    parser.add_argument("--expected-menu-sha256")
    parser.add_argument("--expected-prompt-sha256")
    parser.add_argument("--interval", type=float, default=0.025)
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()
    if not 0 < args.port <= 65535 or not 0 <= args.interval <= 1:
        raise SystemExit("Invalid RFB input bounds")
    sock, width, height = connect(args.host, args.port, args.timeout)
    with sock:
        if (
            args.oobe_command is not None
            or args.active_command is not None
            or args.physical_text is not None
            or args.physical_key
            or args.physical_chord
        ):
            enable_extended_keys(sock, width, height, args.timeout)
        if args.oobe_command is not None:
            chord(sock, "shift+f10", args.interval)
            time.sleep(3.0)
            clipboard(sock, args.oobe_command)
            chord(sock, "shift+insert", args.interval)
            press(sock, SPECIAL["enter"], args.interval)
            time.sleep(2.0)
        if args.active_command is not None:
            clipboard(sock, args.active_command)
            chord(sock, "shift+insert", args.interval)
            press(sock, SPECIAL["enter"], args.interval)
            time.sleep(2.0)
        if args.physical_text is not None:
            physical_text(sock, args.physical_text, args.interval)
        for name in args.physical_key:
            physical_key(sock, name, args.interval)
        for names in args.physical_chord:
            physical_chord(sock, names, args.interval)
        if args.text:
            text(sock, args.text, args.interval)
        if args.clipboard is not None:
            clipboard(sock, args.clipboard)
        for name in args.key:
            press(sock, SPECIAL[name], args.interval)
        for coordinate in args.click:
            click(sock, coordinate, width, height)
        for coordinate in args.right_click:
            click(sock, coordinate, width, height, button_mask=4)
        for names in args.chord:
            chord(sock, names, args.interval)
        if args.boot_selected_cd_if_prompt:
            if not args.expected_menu_sha256 or not args.expected_prompt_sha256:
                raise ValueError("Exact menu and prompt digests are required")
            boot_selected_cd_if_prompt(
                sock,
                args.host,
                args.port,
                args.timeout,
                args.interval,
                args.expected_menu_sha256,
                args.expected_prompt_sha256,
            )
        if args.screenshot:
            screenshot(sock, width, height, args.screenshot)
        elif args.text or args.key or args.click or args.chord:
            time.sleep(0.5)


if __name__ == "__main__":
    main()
