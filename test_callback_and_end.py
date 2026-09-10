import asyncio, json, uuid, wave, io, time, sys
import aiohttp, websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import AudioFrame
import numpy as np

async def main():
    email = sys.argv[1]
    password = sys.argv[2]
    
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://localhost:8000/api/v1/auth/login",
            json={"email": email, "password": password}
        ) as resp:
            tok = (await resp.json())["token"]

        async with session.post(
            "http://localhost:8000/api/v1/workflow/3/runs",
            headers={"Authorization": f"Bearer {tok}"},
            json={"name": f"test-run-callback-{uuid.uuid4().hex[:6]}", "mode": "smallwebrtc"}
        ) as resp:
            run_id = (await resp.json())["id"]
            print(f"Created run {run_id} for callback/end test")

    ws_url = f"ws://localhost:8000/api/v1/ws/signaling/3/{run_id}?token={tok}"
    async with websockets.connect(ws_url) as ws:
        pc = RTCPeerConnection()
        pc_id = f"pc_{uuid.uuid4().hex[:8]}"
        
        class AudioTrack(MediaStreamTrack):
            kind = "audio"
            def __init__(self):
                super().__init__()
                self.time = 0
                self.sample_rate = 16000
                self.samples = 160
                self.queue = asyncio.Queue()
                self.playing = False
                
            def queue_file(self, path):
                with wave.open(path, "rb") as w:
                    raw = w.readframes(w.getnframes())
                chunk_size = 320
                for i in range(0, len(raw), chunk_size):
                    chunk = raw[i:i+chunk_size]
                    if len(chunk) < chunk_size:
                        chunk = chunk.ljust(chunk_size, b"\x00")
                    self.queue.put_nowait(chunk)
                print(f"Queued {path} ({len(raw)} bytes)")
                
            async def recv(self):
                await asyncio.sleep(0.01)
                if not self.queue.empty():
                    raw = self.queue.get_nowait()
                    data = np.frombuffer(raw, dtype=np.int16)
                    self.playing = True
                else:
                    data = np.zeros(self.samples, dtype=np.int16)
                    self.playing = False
                frame = AudioFrame.from_ndarray(data.reshape(1, -1), format="s16", layout="mono")
                frame.sample_rate = self.sample_rate
                frame.pts = self.time
                self.time += self.samples
                return frame

        track = AudioTrack()
        pc.addTrack(track)
        
        received = []
        @pc.on("track")
        def on_track(t):
            if t.kind == "audio":
                asyncio.create_task(rec(t))
                
        async def rec(t):
            while True:
                try:
                    f = await t.recv()
                    received.append(f.to_ndarray().tobytes())
                except:
                    break

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await ws.send(json.dumps({
            "type": "offer",
            "payload": {"pc_id": pc_id, "sdp": pc.localDescription.sdp, "type": "offer", "call_context_vars": {}}
        }))
        
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("type") == "answer":
                await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["payload"]["sdp"], type="answer"))
                print("WebRTC media connected")
                break

        # 1. Greeting
        print("Waiting 8s for Greeting...")
        await asyncio.sleep(8)
        
        # 2. Callback request
        print("Sending Callback request audio...")
        track.queue_file("/tmp/user_inputs/q5_callback.wav")
        await asyncio.sleep(12)
        
        # 3. End conversation
        print("Sending End conversation audio...")
        track.queue_file("/tmp/user_inputs/q6_end.wav")
        await asyncio.sleep(8)
        
        await pc.close()
        print(f"Done. Collected {len(received)} frames.")
        if received:
            pcm = b"".join(received)
            with wave.open("/tmp/callback_end_bot.wav", "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(48000)
                wf.writeframes(pcm)
            print("Wrote /tmp/callback_end_bot.wav")

asyncio.run(main())
