"""
End-to-end protocol test for the Async File Server.

Talks raw TCP to the C server (no bridge involved) and checks framing,
file operations, validation, concurrency across the 4 workers, the
event stream and resilience to clients that disappear mid-request.

Usage:  python backend/tests/protocol_test.py [host] [port]
"""

import json
import socket
import sys
import threading
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8080

failures = 0


def check(name, condition, detail=""):
    global failures
    status = "PASS" if condition else "FAIL"
    if not condition:
        failures += 1
    print(f"[{status}] {name}" + (f"  -- {detail}" if detail and not condition else ""))


class Conn:
    def __init__(self):
        self.sock = socket.create_connection((HOST, PORT), timeout=10)
        self.buf = b""

    def send(self, data: bytes):
        self.sock.sendall(data)

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise ConnectionError("closed")
        self.buf += chunk

    def read_line(self) -> bytes:
        while b"\n" not in self.buf:
            self._fill()
        line, self.buf = self.buf.split(b"\n", 1)
        return line

    def read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            self._fill()
        data, self.buf = self.buf[:n], self.buf[n:]
        return data

    def frame(self):
        header = self.read_line().decode()
        parts = header.split(" ")
        kind = parts[0]
        if kind == "RESP":
            rid, length, status = int(parts[1]), int(parts[2]), parts[3]
            tag = parts[4] if len(parts) > 4 else None
            return {"kind": kind, "id": rid, "status": status, "tag": tag,
                    "payload": self.read_exact(length)}
        if kind == "EVENT":
            length = int(parts[2])
            return {"kind": kind, "event": json.loads(self.read_exact(length))}
        raise ValueError(f"bad header {header!r}")

    def request(self, line: str, payload: bytes = b""):
        self.send(line.encode() + b"\n" + payload)
        return self.frame()

    def close(self):
        self.sock.close()


def main():
    c = Conn()

    r = c.request("PING")
    check("PING returns OK JSON", r["status"] == "OK" and json.loads(r["payload"])["pong"])

    # ---- legacy line protocol --------------------------------------
    r = c.request("WRITE legacy_test.txt hello from the legacy protocol")
    check("legacy WRITE succeeds", r["status"] == "OK" and r["id"] > 0, r)
    check("legacy WRITE keeps original success text",
          r["payload"] == b"SUCCESS: File written successfully.")

    r = c.request("READ legacy_test.txt")
    check("legacy READ returns written data",
          r["payload"] == b"hello from the legacy protocol", r["payload"])

    r = c.request("READ definitely_missing_file.txt")
    check("READ missing file -> ENOENT", r["status"] == "ENOENT"
          and r["payload"] == b"ERROR: File not found.", r)

    # ---- binary-safe multi-line write ------------------------------
    body = "line one\nline two with ünïcødé\n\ttabbed\n".encode()
    r = c.request(f"WRITEB multi_line.txt {len(body)}", body)
    check("WRITEB succeeds", r["status"] == "OK", r)
    r = c.request("READ multi_line.txt")
    check("WRITEB content round-trips exactly", r["payload"] == body, r["payload"])

    r = c.request("WRITEB empty_file.txt 0")
    r2 = c.request("READ empty_file.txt")
    check("zero-length WRITEB/READ", r["status"] == "OK" and r2["payload"] == b"", (r, r2))

    # ---- create ----------------------------------------------------
    name = f"created_{int(time.time() * 1000)}.txt"
    r = c.request(f"CREATE {name}")
    check("CREATE new file", r["status"] == "OK", r)
    r = c.request(f"CREATE {name}")
    check("CREATE existing file -> EEXIST", r["status"] == "EEXIST", r)

    # ---- validation / traversal ------------------------------------
    for bad in ["../server.c", "..", ".hidden", "a/b.txt", "/etc/passwd", "x%00y"]:
        r = c.request(f"READ {bad}")
        check(f"rejects filename {bad!r}", r["status"] == "EINVAL", r)
    r = c.request("FROB x")
    check("unknown command -> EINVAL", r["status"] == "EINVAL", r)
    r = c.request("WRITE nospace")
    check("malformed WRITE -> EINVAL", r["status"] == "EINVAL", r)
    r = c.request("READ " + "a" * 5000)
    check("over-long line rejected, stream stays in sync", r["status"] == "EINVAL", r)
    r = c.request("PING")
    check("connection usable after over-long line", r["status"] == "OK")

    # ---- tags + pipelining -----------------------------------------
    n = 12
    batch = b"".join(f"@t{i} READ small.txt\n".encode() for i in range(n))
    c.send(batch)
    frames = [c.frame() for _ in range(n)]
    tags = sorted(f["tag"] for f in frames)
    check("12 pipelined requests all answered", len(frames) == n)
    check("tags echoed for correlation", tags == sorted(f"t{i}" for i in range(n)), tags)
    check("distinct request ids", len({f["id"] for f in frames}) == n)

    # ---- LIST ------------------------------------------------------
    r = c.request("LIST")
    listing = json.loads(r["payload"])
    names = {f["name"] for f in listing["files"]}
    check("LIST includes written files", {"multi_line.txt", name} <= names, names)
    check("LIST hides temp/hidden files", not any(x.startswith(".") for x in names))

    # ---- STATS -----------------------------------------------------
    r = c.request("STATS")
    stats = json.loads(r["payload"])
    check("STATS has 4 workers", len(stats["workers"]) == 4)
    check("STATS counts completions", stats["totals"]["completed"] >= n + 6, stats["totals"])
    check("STATS counts rejections", stats["totals"]["rejected"] >= 6, stats["totals"])

    r = c.request("LOGS 50")
    logs = json.loads(r["payload"])["logs"]
    check("LOGS returns entries with levels", logs and all("level" in l for l in logs))

    # ---- event stream + concurrency --------------------------------
    sub = Conn()
    hello = sub.request("SUBSCRIBE")
    check("SUBSCRIBE handshake", hello["status"] == "OK")

    events = []
    stop = threading.Event()

    def collect():
        while not stop.is_set():
            try:
                f = sub.frame()
            except Exception:
                return
            events.append(f["event"])

    t = threading.Thread(target=collect, daemon=True)
    t.start()

    # 8 large reads from separate connections at once
    def big_read(results, i):
        k = Conn()
        results[i] = k.request("READ large.txt")
        k.close()

    results = [None] * 8
    threads = [threading.Thread(target=big_read, args=(results, i)) for i in range(8)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    check("8 concurrent large reads succeed",
          all(r and r["status"] == "OK" and len(r["payload"]) > 1_000_000 for r in results))

    time.sleep(0.5)
    started = [e for e in events if e["type"] == "request_started"]
    workers_used = {e["worker"] for e in started}
    check("requests spread over multiple workers", len(workers_used) >= 2, workers_used)

    # overlap: some request started before another finished
    timeline = [(e["seq"], e["type"], e.get("worker")) for e in events
                if e["type"] in ("request_started", "request_finished")]
    busy = 0
    max_busy = 0
    for _, typ, _ in timeline:
        busy += 1 if typ == "request_started" else -1
        max_busy = max(max_busy, busy)
    check("workers processed requests concurrently", max_busy >= 2, f"max concurrent={max_busy}")
    print(f"       workers used: {sorted(workers_used)}, max concurrent: {max_busy}")

    seqs = [e["seq"] for e in events if e.get("seq")]
    check("event sequence strictly increasing", seqs == sorted(seqs) and len(set(seqs)) == len(seqs))

    # ---- client vanishes mid-request -------------------------------
    for _ in range(4):
        k = Conn()
        k.send(b"READ large.txt\n")
        k.close()
    time.sleep(1.0)
    r = c.request("PING")
    check("server survives clients disconnecting mid-request", r["status"] == "OK")

    stop.set()
    sub.close()
    c.request("EXIT")
    c.close()

    print()
    print("ALL TESTS PASSED" if failures == 0 else f"{failures} TEST(S) FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
