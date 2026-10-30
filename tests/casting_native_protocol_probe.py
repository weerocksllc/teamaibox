"""Missing native TCP rejection paths only; run in a disposable media image.

No real sender, positive PIN pairing, platform authorization or timing claim.
"""
import json
import os
import plistlib
import socket
import subprocess
import tempfile
from pathlib import Path
import time
import hashlib
import hmac

from services.trusted_media_service.private_discovery import PrivateDiscovery, private_bus_environment


def response(channel):
    stream = channel.makefile("rb")
    status = stream.readline(1024).decode().strip()
    headers = {}
    while True:
        line = stream.readline(4096)
        if line == b"\r\n":
            break
        if not line:
            raise AssertionError("response_headers_truncated")
        k, v = line.decode().split(":", 1)
        headers[k.lower()] = v.strip()
    size = int(headers.get("content-length", "0"))
    assert 0 <= size <= 65536
    body = stream.read(size)
    assert len(body) == size
    # detach is not offered by SocketIO buffered readers; closing the makefile
    # drops only its reference, not the still-owned original socket.
    stream.close()
    return int(status.split()[1]), body


def send(channel, method, path, body=b"", agent="AirPlay/920.1"):
    channel.sendall((f"{method} {path} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: {agent}\r\n"
                     f"Content-Type: application/x-apple-binary-plist\r\nContent-Length: {len(body)}\r\n\r\n").encode()+body)
    return response(channel)


def connect():
    # UxPlay's RAOP control listener uses the second configured TCP port.
    return socket.create_connection(("127.0.0.1", 47001), timeout=3)


# SRP-2048 parameters from RFC 5054; Apple key derivation matches the pinned
# UxPlay lib/srp.c, commit 21eef8df25d91e12635c36d8176ad192725baca2.
N=int('AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4'
      'A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF60'
      '95179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF'
      '747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B907'
      '8717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB37861'
      '60279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DB'
      'FBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73',16)
USER='synthetic-negative-probe'
def integer_bytes(n): return n.to_bytes((n.bit_length()+7)//8,'big')
def sha(b): return hashlib.sha1(b).digest()
def number(b): return int.from_bytes(b,'big')
def binary(v): return plistlib.dumps(v,fmt=plistlib.FMT_BINARY)

def srp_proof(challenge,pin):
    salt=challenge['salt']; B=number(challenge['pk'])
    assert 0 < B < N
    a=number(os.urandom(32)); A=pow(2,a,N)
    k=number(sha(N.to_bytes(256,'big')+(2).to_bytes(256,'big')))
    u=number(sha(A.to_bytes(256,'big')+B.to_bytes(256,'big')))
    x=number(sha(salt+sha((USER+':'+pin).encode())))
    shared=integer_bytes(pow((B-k*pow(2,x,N))%N,a+u*x,N))
    key=sha(shared+b'\0\0\0\0')+sha(shared+b'\0\0\0\1')
    xor=bytes(a^b for a,b in zip(sha(integer_bytes(N)),sha(b'\x02')))
    proof=sha(xor+sha(USER.encode())+salt+integer_bytes(A)+integer_bytes(B)+key)
    return {'pk':integer_bytes(A),'proof':proof},sha(integer_bytes(A)+proof+key)

def check_srp_boundaries():
    events=[]
    def challenge(channel):
        status,body=send(channel,'POST','/pair-setup-pin',binary({'method':'pin','user':USER}))
        assert status==200
        value=plistlib.loads(body); assert value['pk'] and value['salt']; return value
    with connect() as channel:
        request,expected=srp_proof(challenge(channel),'1234')
        status,body=send(channel,'POST','/pair-setup-pin',binary(request))
        assert status==200 and hmac.compare_digest(plistlib.loads(body)['proof'],expected),'valid_srp_control_failed'
        events.append({'case':'correct_pin_positive_srp_control','passed':True})
        status,_=send(channel,'POST','/pair-setup-pin',binary(request))
        assert status==470,('same_connection_replay',status)
        events.append({'case':'same_connection_srp_replay','passed':True,'status':status})
    with connect() as channel:
        challenge(channel)
        status,_=send(channel,'POST','/pair-setup-pin',binary(request))
        assert status==470,('new_challenge_replay',status)
        events.append({'case':'fresh_connection_srp_replay','passed':True,'status':status})
    for attempt in range(3):
        with connect() as channel:
            wrong,_=srp_proof(challenge(channel),'9999')
            status,_=send(channel,'POST','/pair-setup-pin',binary(wrong))
            assert status==470,('wrong_pin',status)
    events.append({'case':'computed_wrong_pin_on_three_new_connections','passed':True})
    with connect() as channel:
        correct,_=srp_proof(challenge(channel),'1234')
        status,_=send(channel,'POST','/pair-setup-pin',binary(correct))
        assert status==470,('new_connection_cannot_bypass_cooldown',status)
    events.append({'case':'process_wide_cooldown_blocks_valid_pin','passed':True})
    print(json.dumps({'progress':'cooldown-observed','nativeCasesCompleted':len(events)}),flush=True)
    time.sleep(61)
    with connect() as channel:
        correct,expected=srp_proof(challenge(channel),'1234')
        status,body=send(channel,'POST','/pair-setup-pin',binary(correct))
        assert status==200 and hmac.compare_digest(plistlib.loads(body)['proof'],expected),'cooldown_did_not_recover'
    events.append({'case':'correct_pin_recovers_after_cooldown','passed':True,'waitSeconds':61})
    return {'cases':events,'validTranscriptReplayTested':True,'bruteForceCooldownMeasured':True,
            'positiveSrpProofAccepted':True,'positivePairingAccepted':False,'physicalAppleSenderTested':False,
            'receiverAliveAfterRequests':True}


def run():
    discovery = PrivateDiscovery(interface="eth0")
    child = None
    cases = []
    log = tempfile.TemporaryFile()
    try:
        discovery.start(receiver_name="Team-AI-000000ABCD")
        env = {**os.environ, **private_bus_environment(), "GST_REGISTRY":"/tmp/native-registry.bin"}
        child = subprocess.Popen(["/usr/bin/uxplay", "-n", "Team-AI-000000ABCD", "-nh",
            "-m", "-p", "47000", "-srgb", "no", "-vd", "avdec_h264", "-vs", "fakesink",
            "-as", "fakesink"], stdin=subprocess.PIPE, stdout=log,
            stderr=log, env=env)
        child.stdin.write(b"1234\n"); child.stdin.close()
        deadline = time.monotonic()+10
        while True:
            assert child.poll() is None, "receiver_exited_before_requests"
            try:
                with connect() as channel:
                    status, _ = send(channel, "OPTIONS", "*")
                    assert status == 200
                break
            except ConnectionRefusedError:
                if time.monotonic() >= deadline:
                    ports=Path('/proc/net/tcp').read_text()+Path('/proc/net/tcp6').read_text()
                    wait=Path(f'/proc/{child.pid}/wchan').read_text()
                    child.terminate(); child.wait(timeout=5)
                    log.seek(0)
                    raise AssertionError('receiver_not_listening:'+log.read().decode()[-1200:]+':'+wait+':'+ports[-1000:])
                time.sleep(0.1)
        if os.environ.get('NATIVE_SRP_ONLY')=='1':
            return check_srp_boundaries()
        def reject(name, method, path, payload=b"", agent="AirPlay/920.1", setup=False,
                   empty_challenge_rejection=False):
            with connect() as channel:
                if setup:
                    status, body = send(channel, "POST", "/pair-setup-pin", plistlib.dumps(
                        {"method":"pin", "user":"synthetic-negative-probe"}, fmt=plistlib.FMT_BINARY))
                    assert status == 200, ("pin_challenge_unavailable", status)
                    challenge = plistlib.loads(body)
                    assert len(challenge["pk"]) > 0 and len(challenge["salt"]) > 0
                status, reply = send(channel, method, path, payload, agent)
                setup_denied = None
                if empty_challenge_rejection:
                    # Upstream returns an empty 200 on an invalid method,
                    # not an SRP challenge. Prove it did not authorize media.
                    assert status == 200 and reply == b'', (name,status)
                    setup_denied, _ = send(channel, 'SETUP','/stream',plistlib.dumps(
                        {'streams':[{'type':110}]},fmt=plistlib.FMT_BINARY))
                    assert setup_denied == 470
                else:
                    assert status == 470, (name, status)
                cases.append({"case":name, "status":status, "rejected":True,
                              "validSrpChallengeObserved":setup,
                              "emptyChallengeThenSetupDenied":setup_denied})
        reject("pinless_pair_setup", "POST", "/pair-setup", b"x"*32)
        reject("unapproved_pair_verify", "POST", "/pair-verify", b"\x01\0\0\0"+b"x"*64)
        payload = plistlib.dumps({"streams":[{"type":110}]}, fmt=plistlib.FMT_BINARY)
        reject("unpaired_stream_setup", "SETUP", "/stream", payload)
        reject("legacy_plaintext_client_setup", "SETUP", "/stream", payload, "AirMyPC/7200")
        reject("truncated_method_not_pin", "POST", "/pair-setup-pin", plistlib.dumps(
            {"method":"pi", "user":"synthetic-negative-probe"}, fmt=plistlib.FMT_BINARY),
            empty_challenge_rejection=True)
        for name, pk, proof in [("invalid_srp_proof", b"\x02"*256, b"x"*20),
                                ("short_srp_proof", b"\x02"*256, b"x"*19),
                                ("oversize_srp_key", b"\x02"*257, b"x"*20)]:
            reject(name, "POST", "/pair-setup-pin", plistlib.dumps(
                {"pk":pk,"proof":proof}, fmt=plistlib.FMT_BINARY), setup=True)
        with connect() as channel:
            status, _ = send(channel, "OPTIONS", "*")
            assert status == 200 and child.poll() is None
        return {"cases":cases, "receiverAliveAfterRequests":True,
                "nativeBinarySha256":__import__('hashlib').sha256(open('/usr/bin/uxplay','rb').read()).hexdigest(),
                "positivePairingAccepted":False, "validTranscriptReplayTested":False,
                "physicalAppleSenderTested":False, "bruteForceCooldownMeasured":False}
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait(timeout=3)
        discovery.close()
        log.close()


if __name__ == "__main__":
    print(json.dumps(run()))
