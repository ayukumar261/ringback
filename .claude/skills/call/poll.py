#!/usr/bin/env python3
# Prints a call's transcript as it happens and exits once the call has ended.
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API = os.environ.get("RINGBACK_API_URL", "https://ringback.ayukumar261.com/api")
ANSWER_WAIT = 90
TIMEOUT = int(sys.argv[2]) if len(sys.argv) > 2 else 900
POLL = 3


def get(path):
    with urllib.request.urlopen(f"{API}{path}", timeout=10) as r:
        return json.load(r)


def snapshot(room):
    for call in get("/calls"):
        if call.get("room") == room:
            return call
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: poll.py <room> [timeout-seconds]")
    room = sys.argv[1]
    enc = urllib.parse.quote(room, safe="")
    start = time.time()
    printed = {}
    call = None
    while True:
        elapsed = time.time() - start
        try:
            call = snapshot(room)
        except Exception as e:
            print(f"[poll] GET /calls failed, retrying: {e}", flush=True)
        if call is None:
            if elapsed > ANSWER_WAIT:
                print(f"[poll] no call record after {ANSWER_WAIT}s, the line was not answered or never connected", flush=True)
                sys.exit(2)
            time.sleep(POLL)
            continue
        try:
            turns = get(f"/calls/{enc}/turns")
        except Exception:
            turns = []
        # a repeated seq corrects earlier text so reprint when the text changed
        for t in sorted(turns, key=lambda t: t["seq"]):
            if printed.get(t["seq"]) != t["text"]:
                tag = "(fixed) " if t["seq"] in printed else ""
                print(f"{t['seq']:>3} {t['role']:<5} {tag}{t['text']}", flush=True)
                printed[t["seq"]] = t["text"]
        if call.get("status") == "ended":
            secs = round((call.get("duration_ms") or 0) / 1000)
            audio = f"{API}/calls/{enc}/audio" if call.get("audio") else "none"
            print(f"[poll] ended after {secs}s, audio {audio}", flush=True)
            sys.exit(0)
        if elapsed > TIMEOUT:
            print(f"[poll] still active after {TIMEOUT}s, giving up on polling", flush=True)
            sys.exit(3)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
