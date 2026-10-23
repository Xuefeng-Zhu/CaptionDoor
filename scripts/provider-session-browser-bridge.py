#!/usr/bin/env python3
"""One-use loopback form feeding the existing launcher's actual hidden PTY."""
import errno
import http.client
import http.server
import os
import pty
import re
import secrets
import select
import shutil
import signal
import socket
import sys
import termios
import threading
import time
import tty
import urllib.parse
from pathlib import Path

ORIGIN = "http://127.0.0.1:3410"
ADDRESS = ("127.0.0.1", 3410)
TOKEN_PROMPT = b"Paste EXISTING approved Ring Playground token (hidden; Enter to submit): "
DEVICE_PROMPT = b"Choose device number (hidden): "
START_PROMPT = b"Type START to begin, or Enter to cancel (hidden): "
FIXTURE_TOKEN = b"Fictional-PTY-Test-Only!123"


class IntakeRejected(Exception):
    def __init__(self, category):
        self.category = category


def status(category):
    print('{"category":"' + category + '"}', flush=True)


def raw_hidden(fd):
    try:
        return not (termios.tcgetattr(fd)[3] & (termios.ECHO | termios.ICANON))
    except (OSError, termios.error):
        return False


class Output:
    """Strip terminal controls; buffer secret-bearing output across chunk boundaries."""
    def __init__(self):
        self.control = None
        self.pending = bytearray()
        self.secret = bytearray()
        self.transcript = bytearray()  # Fictional self-test only; real output is never retained.
        self.capture = False

    def write(self, data, final=False):
        clean = bytearray()
        for value in data:
            if self.control == "escape":
                self.control = "csi" if value == 91 else "osc" if value == 93 else None
            elif self.control == "csi":
                if 64 <= value <= 126:
                    self.control = None
            elif self.control == "osc":
                if value == 7:
                    self.control = None
                elif value == 27:
                    self.control = "osc-escape"
            elif self.control == "osc-escape":
                self.control = None if value == 92 else "osc"
            elif value == 27:
                self.control = "escape"
            elif value in (10, 13) or 32 <= value <= 126:
                clean.append(value)
        self.pending.extend(clean)
        if len(self.pending) > 65536:
            self.pending.clear()
            status("BRIDGE_OUTPUT_BOUND_EXCEEDED")
            return
        while b"\n" in self.pending:
            end = self.pending.index(10) + 1
            self.emit(bytes(self.pending[:end]))
            del self.pending[:end]
        if final or not self.secret or any(self.pending.endswith(p) for p in (DEVICE_PROMPT, START_PROMPT)):
            self.emit(bytes(self.pending))
            self.pending.clear()

    def emit(self, data):
        if self.secret:
            data = data.replace(bytes(self.secret), b"[REDACTED]")
        if self.capture:
            self.transcript.extend(data)
        else:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()


class IntakeServer(http.server.HTTPServer):
    allow_reuse_address = True  # Match Node's loopback listener after this socket closes.

    def __init__(self, bridge):
        self.bridge = bridge
        self.token = None
        self.finished = False
        self.path = "/" + secrets.token_urlsafe(32)
        super().__init__(ADDRESS, IntakeHandler)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(1)
        return request, address

    def handle_error(self, request, client_address):
        self.finished = True  # Never print an exception, request or submitted content.


class IntakeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *unused):
        pass

    def reply(self, code, body):
        encoded = body.encode("ascii")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=us-ascii")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    def authorized(self):
        return self.scope_category() is None

    def scope_category(self):
        if self.path != self.server.path:
            return "BRIDGE_HTTP_NONCE_REJECTED"
        if self.headers.get_all("Host") != ["127.0.0.1:3410"]:
            return "BRIDGE_HTTP_HOST_REJECTED"
        if self.client_address[0] != "127.0.0.1":
            return "BRIDGE_HTTP_PEER_REJECTED"
        if self.server.finished:
            return "BRIDGE_HTTP_REPLAY_REJECTED"
        gate = getattr(self.server.bridge, "not_ready_category", None)
        if gate:
            return gate()
        return None if self.server.bridge.ready() else "BRIDGE_TOKEN_STATE_REJECTED"

    def do_GET(self):
        if not self.authorized():
            self.reply(403, "Intake unavailable.")
            return
        self.reply(200, '<!doctype html><html><title>CaptionDoor temporary intake</title><body><p>Existing approved Playground token. Submitted once to the hidden local launcher.</p><form method="post" action="' + self.server.path + '" autocomplete="off"><label>Token <input type="password" name="token" autocomplete="off" maxlength="8192" required></label><button type="submit">Send to hidden launcher</button></form></body></html>')

    def do_POST(self):
        phase = "BRIDGE_HTTP_REQUEST_REJECTED"
        try:
            failure = self.scope_category()
            if failure:
                raise IntakeRejected(failure)
            if self.headers.get_all("Origin") != [ORIGIN]:
                raise IntakeRejected("BRIDGE_HTTP_ORIGIN_REJECTED")
            if self.headers.get("Transfer-Encoding") is not None:
                raise IntakeRejected("BRIDGE_HTTP_TRANSFER_ENCODING_REJECTED")
            if self.headers.get_all("Content-Type") != ["application/x-www-form-urlencoded"]:
                raise IntakeRejected("BRIDGE_HTTP_CONTENT_TYPE_REJECTED")
            lengths = self.headers.get_all("Content-Length")
            if not lengths or len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,5}", lengths[0]):
                raise IntakeRejected("BRIDGE_HTTP_LENGTH_HEADER_REJECTED")
            length = int(lengths[0])
            if not 7 <= length <= 24582:
                raise IntakeRejected("BRIDGE_HTTP_BODY_SIZE_REJECTED")
            phase = "BRIDGE_HTTP_BODY_READ_REJECTED"
            body = self.rfile.read(length)
            if len(body) != length:
                raise IntakeRejected("BRIDGE_HTTP_BODY_LENGTH_REJECTED")
            failure = self.scope_category()
            if failure:
                raise IntakeRejected(failure)
            phase = "BRIDGE_HTTP_BODY_PARSE_REJECTED"
            fields = urllib.parse.parse_qsl(body.decode("ascii"), strict_parsing=True, encoding="ascii", errors="strict", max_num_fields=1)
            if len(fields) != 1 or fields[0][0] != "token":
                raise IntakeRejected("BRIDGE_HTTP_TOKEN_FIELD_REJECTED")
            token = fields[0][1].encode("ascii")
            if not 1 <= len(token) <= 8192 or any(c < 33 or c > 126 for c in token):
                raise IntakeRejected("BRIDGE_HTTP_TOKEN_FORMAT_REJECTED")
            self.server.token = bytearray(token)
            self.server.finished = True
            phase = "BRIDGE_HTTP_REPLY_FAILED"
            self.reply(200, "Submission received. Check the launcher status.")
        except Exception as error:
            status(error.category if isinstance(error, IntakeRejected) else phase)
            self.server.token = None
            self.server.finished = True
            try:
                self.reply(400, "Intake rejected. Check the launcher status.")
            except Exception:
                pass


class Bridge:
    def __init__(self, args, fixture=False, deadline_seconds=60):
        self.args, self.fixture = args, fixture
        self.deadline_seconds = deadline_seconds
        self.pid = None
        self.fd = None
        self.child_status = None
        self.server = None
        self.deadline = 0
        self.prompt_seen = False
        self.intake_used = False
        self.cancelled = False
        self.output = Output()
        self.output.capture = fixture
        self.tail = bytearray()
        self.input = bytearray()
        self.interaction = None
        self.injected = False
        self.input_open = True

    def alive(self):
        if self.child_status is not None:
            return False
        pid, state = os.waitpid(self.pid, os.WNOHANG)
        if pid:
            self.child_status = state
            return False
        return True

    def ready(self):
        return self.not_ready_category() is None

    def not_ready_category(self):
        if not self.prompt_seen:
            return "BRIDGE_TOKEN_PROMPT_NOT_READY"
        if self.cancelled:
            return "BRIDGE_TOKEN_CANCELLED"
        if self.intake_used:
            return "BRIDGE_TOKEN_ALREADY_FORWARDED"
        if time.monotonic() >= self.deadline:
            return "BRIDGE_TOKEN_DEADLINE_EXPIRED"
        if not self.alive():
            return "BRIDGE_TOKEN_CHILD_NOT_ALIVE"
        if not raw_hidden(self.fd):
            return "BRIDGE_TOKEN_TERMINAL_NOT_HIDDEN"
        return None

    def cancel(self, *_unused):
        self.cancelled = True
        self.close_server()
        if self.pid and self.alive():
            os.kill(self.pid, signal.SIGINT)
        status("BRIDGE_CANCELLATION_FORWARDED_WAITING_FOR_CLEANUP")

    def close_server(self):
        if self.server:
            server, self.server = self.server, None
            server.server_close()  # The accepted connection already closed after handle_request.
            return server.token
        return None

    def inject(self, token):
        # Freeze only the owned child briefly so it cannot restore ECHO between check/write.
        offset = 0
        payload = token + b"\r"
        try:
            while offset < len(payload):
                if not self.ready():
                    raise ValueError()
                stopped = False
                try:
                    os.kill(self.pid, signal.SIGSTOP)
                    until = time.monotonic() + 1
                    while True:
                        pid, state = os.waitpid(self.pid, os.WUNTRACED | os.WNOHANG)
                        if pid:
                            if not os.WIFSTOPPED(state):
                                self.child_status = state
                                raise ValueError()
                            stopped = True
                            break
                        if time.monotonic() >= until:
                            raise ValueError()
                        time.sleep(0.001)
                    if self.cancelled or time.monotonic() >= self.deadline or not raw_hidden(self.fd):
                        raise ValueError()
                    # Queue Enter separately, only after every token byte has been queued.
                    end = min(offset + 512, len(token)) if offset < len(token) else len(payload)
                    try:
                        offset += os.write(self.fd, payload[offset:end])
                    except BlockingIOError:
                        pass
                finally:
                    # SIGCONT is also required when stop observation times out.
                    if self.child_status is None:
                        os.kill(self.pid, signal.SIGCONT)
                time.sleep(0.002)
            self.injected = True
            self.intake_used = True
            status("BRIDGE_TOKEN_FORWARDED_WITHOUT_ECHO")
        finally:
            for index in range(len(payload)):
                payload[index] = 0

    def start(self):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            if self.fixture:
                fixture_child()
                os._exit(0)
            os.chdir(Path(__file__).resolve().parent.parent)
            node = shutil.which("node")
            if not node:
                os._exit(2)
            os.execv(node, [node, "--import", "tsx", "scripts/provider-session-remote.ts", *self.args])
        os.set_blocking(self.fd, False)

    def read_child(self):
        try:
            data = os.read(self.fd, 8192)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EIO):
                return
            raise
        if not data:
            return
        self.output.write(data)
        self.tail.extend(data)
        self.tail = self.tail[-1024:]
        if not self.prompt_seen and TOKEN_PROMPT in self.tail:
            self.prompt_seen = True
            self.deadline = time.monotonic() + self.deadline_seconds
            if not raw_hidden(self.fd):
                self.cancel()
                return
            self.server = IntakeServer(self)
            status("BRIDGE_ONE_TIME_INTAKE_READY")
            if self.fixture:
                threading.Thread(target=fixture_post, args=(self.server.path,), daemon=True).start()
            else:
                print(ORIGIN + self.server.path, flush=True)  # Random intake nonce only.
        if DEVICE_PROMPT in self.tail:
            self.interaction = "device"
        if START_PROMPT in self.tail:
            self.interaction = "start"

    def read_input(self):
        data = os.read(0, 512)
        if not data:
            self.input_open = False
            return
        self.input.extend(data)
        if len(self.input) > 64:
            self.input.clear()
            status("BRIDGE_NONSECRET_INPUT_REJECTED")
            return
        if b"\n" not in self.input and b"\r" not in self.input:
            return
        line = bytes(self.input).strip(b"\r\n")
        self.input.clear()
        valid = (self.interaction == "device" and re.fullmatch(rb"[1-9][0-9]{0,2}", line)) or (self.interaction == "start" and line in (b"START", b""))
        if not self.intake_used or not valid or not self.alive() or not raw_hidden(self.fd):
            status("BRIDGE_NONSECRET_INPUT_REJECTED")
            return
        os.write(self.fd, line + b"\r")
        self.interaction = None
        self.tail.clear()

    def run(self):
        old_handlers = {}
        try:
            self.start()
            for kind in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                old_handlers[kind] = signal.signal(kind, self.cancel)
            while self.alive():
                surfaces = [self.fd]
                if not self.fixture and self.input_open:
                    surfaces.append(0)
                if self.server:
                    surfaces.append(self.server.fileno())
                ready, _, _ = select.select(surfaces, [], [], 0.1)
                if self.fd in ready:
                    self.read_child()
                if self.server and self.server.fileno() in ready:
                    self.server.handle_request()
                    if self.server.finished:
                        token = self.close_server()
                        if token is None:
                            self.cancel()
                        else:
                            self.output.secret = token
                            try:
                                with socket.socket() as check:
                                    check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                                    check.bind(ADDRESS)  # Prove backend port released before PTY input.
                                self.inject(token)
                            except Exception:
                                status("BRIDGE_INTAKE_NOT_FORWARDED")
                                self.cancel()
                if 0 in ready:
                    self.read_input()
                if self.prompt_seen and not self.intake_used and not self.cancelled and time.monotonic() >= self.deadline:
                    status("BRIDGE_INTAKE_DEADLINE_EXPIRED")
                    self.cancel()
            self.read_child()
            self.output.write(b"", final=True)
            return os.waitstatus_to_exitcode(self.child_status)
        except Exception:
            status("BRIDGE_FAILED_WAITING_FOR_CHILD_CLEANUP")
            self.cancel()
            while self.pid and self.alive():
                ready, _, _ = select.select([self.fd], [], [], 0.1)
                if ready:
                    self.read_child()
            return 2
        finally:
            self.close_server()
            for kind, previous in old_handlers.items():
                signal.signal(kind, previous)
            if self.fd is not None:
                os.close(self.fd)
            for index in range(len(self.output.secret)):
                self.output.secret[index] = 0


def fixture_child():
    original = termios.tcgetattr(0)
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    try:
        tty.setraw(0)
        os.write(1, TOKEN_PROMPT)
        token = bytearray()
        while True:
            data = os.read(0, 1)
            if data == b"\r":
                break
            token.extend(data)
        termios.tcsetattr(0, termios.TCSANOW, original)
        os.write(1, b"\nFIXTURE_HIDDEN_INPUT_RECEIVED\n" if token == FIXTURE_TOKEN else b"\nFIXTURE_FAILED\n")
    finally:
        termios.tcsetattr(0, termios.TCSANOW, original)


def fixture_post(path):
    try:
        connection = http.client.HTTPConnection(*ADDRESS, timeout=3)
        connection.request("GET", path)
        response = connection.getresponse()
        assert response.status == 200 and response.getheader("Cache-Control") == "no-store"
        assert response.getheader("Referrer-Policy") == "same-origin"
        form = response.read()
        assert b'type="password"' in form and b"<script" not in form
        connection.close()
        connection = http.client.HTTPConnection(*ADDRESS, timeout=3)
        connection.request("POST", path, urllib.parse.urlencode({"token": FIXTURE_TOKEN.decode("ascii")}), {"Origin": ORIGIN, "Content-Type": "application/x-www-form-urlencoded"})
        response = connection.getresponse()
        assert response.status == 200
        response.read()
        connection.close()
    except Exception:
        status("BRIDGE_SELF_TEST_HTTP_FAILED")


def negative_self_tests():
    """Real HTTP rejection paths plus a real PTY whose terminal is not hidden."""
    class Gate:
        open = True

        def ready(self):
            return self.open

    def request(server, headers, body="token=Fictional", path=None):
        worker = threading.Thread(target=server.handle_request)
        worker.start()
        connection = http.client.HTTPConnection(*ADDRESS, timeout=2)
        if isinstance(headers, list):
            connection.putrequest("POST", path or server.path)
            for name, value in headers:
                connection.putheader(name, value)
            connection.endheaders(body.encode("ascii"))
        else:
            connection.request("POST", path or server.path, body, headers)
        response = connection.getresponse()
        code, content = response.status, response.read()
        connection.close()
        worker.join(2)
        assert not worker.is_alive() and b"Fictional" not in content
        return code

    standard = {"Origin": ORIGIN, "Content-Type": "application/x-www-form-urlencoded"}
    cases = [
        ({**standard, "Origin": "https://other.invalid"}, "token=Fictional", True),
        ({**standard, "Host": "other.invalid:3410"}, "token=Fictional", True),
        (standard, "token=" + "F" * 24583, True),
        (standard, "token=Fictional&token=Other", True),
        ([*standard.items(), ("Content-Length", "15"), ("Content-Length", "15")], "token=Fictional", True),
        (standard, "token=Fictional", False),  # Expired/unready nonce gate.
    ]
    for headers, body, available in cases:
        gate = Gate()
        gate.open = available
        server = IntakeServer(gate)
        try:
            assert request(server, headers, body) == 400
            assert server.token is None and server.finished
        finally:
            server.server_close()
    server = IntakeServer(Gate())
    assert request(server, standard) == 200
    assert request(server, standard, "token=Replay") == 400
    assert server.token is None  # A rejected replay never supplies a second value for forwarding.
    server.server_close()
    with socket.socket() as probe:
        assert probe.connect_ex(ADDRESS) != 0  # Closed intake also refuses network replay.
    master, slave = pty.openpty()
    try:
        rejected = Bridge([], fixture=True)
        rejected.fd = master
        rejected.prompt_seen = True
        rejected.alive = lambda: True
        for flags in (termios.ECHO, termios.ICANON, termios.ECHO | termios.ICANON, 0):
            tty.setraw(slave)
            attrs = termios.tcgetattr(slave)
            attrs[3] |= flags
            termios.tcsetattr(slave, termios.TCSANOW, attrs)
            assert raw_hidden(master) == (flags == 0)
            rejected.deadline = time.monotonic() + 60 if flags else time.monotonic() - 1
            try:
                rejected.inject(bytearray(FIXTURE_TOKEN))
                raise AssertionError()
            except ValueError:
                pass
            assert not select.select([slave], [], [], 0)[0]  # No token bytes for any closed gate.
    finally:
        os.close(master)
        os.close(slave)


def parse_args(args):
    if args == ["--self-test"]:
        return True
    required = {"--start", "--approved-aws-writes", "--approved-cloud-storage", "--approved-cleanup"}
    seen = set()
    index = 0
    while index < len(args):
        value = args[index]
        if value in seen:
            raise ValueError()
        seen.add(value)
        if value in required or value == "--approved-root":
            index += 1
            continue
        if value not in ("--profile", "--baseline") or index + 1 >= len(args):
            raise ValueError()
        parameter = args[index + 1]
        if value == "--profile" and not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", parameter):
            raise ValueError()
        if value == "--baseline" and (not os.path.isabs(parameter) or any(ord(c) < 32 for c in parameter)):
            raise ValueError()
        index += 2
    if not required.issubset(seen) or not {"--profile", "--baseline"}.issubset(seen):
        raise ValueError()
    if "RING_PLAYGROUND_TOKEN" in os.environ:
        raise ValueError()
    return False


if __name__ == "__main__":
    try:
        fixture = parse_args(sys.argv[1:])
        bridge = Bridge([] if fixture else sys.argv[1:], fixture=fixture)
        code = bridge.run()
        if fixture:
            passed = code == 0 and bridge.injected and FIXTURE_TOKEN not in bridge.output.transcript and b"FIXTURE_HIDDEN_INPUT_RECEIVED" in bridge.output.transcript
            if passed:
                negative_self_tests()
            status("BRIDGE_SELF_TEST_PASS" if passed else "BRIDGE_SELF_TEST_FAIL")
            code = 0 if passed else 2
        sys.exit(code)
    except Exception:
        status("BRIDGE_ARGUMENT_OR_STARTUP_REJECTED")
        sys.exit(2)
