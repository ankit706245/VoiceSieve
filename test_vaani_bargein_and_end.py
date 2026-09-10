import asyncio, json, uuid, wave, io, time, os, sys
import aiohttp, websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import AudioFrame
import numpy as np

async def main():
    email = sys.argv[1]
    password = sys.argv[2]
    
    print("=== STARTING VAANI BARGE-IN (TEST 8) AND END CALL (TEST 9) ===")
    
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://localhost:8000/api/v1/auth/login",
            json={"email": email, "password": password}
        ) as resp:
            tok = (await resp.json())["token"]

        async with session.post(
            "http://localhost:8000/api/v1/workflow/3/runs",
            headers={"Authorization": f"Bearer {tok}"},
            json={"name": f"vaani-bargein-end-{uuid.uuid4().hex[:6]}", "mode": "smallwebrtc"}
        ) as resp:
            run_id = (await resp.json())["id"]
            print(f"[RUN] Created smallwebrtc run: id={run_id}")

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
                print(f"[TRACK] Queued {path} ({len(raw)} bytes, {len(raw)/32000:.1f}s)")
                
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
        
        received_frames = []
        is_bot_speaking = False
        speaking_transitions = []
        
        @pc.on("track")
        def on_track(t):
            if t.kind == "audio":
                asyncio.create_task(collect_audio(t))
                
        async def collect_audio(t):
            nonlocal is_bot_speaking
            silence_counter = 0
            while True:
                try:
                    f = await t.recv()
                    arr = f.to_ndarray()
                    received_frames.append(arr.tobytes())
                    energy = np.abs(arr).mean()
                    if energy > 250:
                        if not is_bot_speaking:
                            is_bot_speaking = True
                            t_now = time.time()
                            speaking_transitions.append(("bot_started", t_now))
                            print(f"\n>>> [BOT STARTED SPEAKING] energy={energy:.0f} at {t_now:.2f}")
                        silence_counter = 0
                    else:
                        silence_counter += 1
                        if silence_counter > 40 and is_bot_speaking:
                            is_bot_speaking = False
                            t_now = time.time()
                            speaking_transitions.append(("bot_stopped", t_now))
                            print(f"\n<<< [BOT STOPPED SPEAKING] at {t_now:.2f}")
                except Exception:
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
                print("[WEBRTC] Media connected!")
                break

        # 0. Wait for initial Greeting
        print("\n--- STAGE 0: Initial Greeting ---")
        await asyncio.sleep(7.0)
        print("[STAGE 0] Greeting finished.")

        # TEST 8: INTERRUPTION / BARGE-IN
        print("\n--- TEST 8: INTERRUPTION / BARGE-IN ---")
        print("[TEST 8] Sending question to prompt bot speaking...")
        track.queue_file("/tmp/vaani_test_inputs/test2_business.wav")
        # Wait until user question finishes playing
        while track.playing:
            await asyncio.sleep(0.2)
            
        print("[TEST 8] Waiting for bot to start speaking...")
        t_wait = time.time()
        while time.time() - t_wait < 10 and not is_bot_speaking:
            await asyncio.sleep(0.2)
            
        print("[TEST 8] Bot is actively speaking! Allowing speech for 1.2s before interrupting...")
        await asyncio.sleep(1.2)
        
        t_interrupt = time.time()
        print(f">>> [TEST 8] INJECTING BARGE-IN INTERRUPTION SPEECH at {t_interrupt:.2f}")
        track.queue_file("/tmp/vaani_test_inputs/test8_bargein.wav")
        
        # Monitor bot stopping
        bargein_stopped = False
        t_stopped = None
        while track.playing:
            await asyncio.sleep(0.1)
            if not is_bot_speaking and not bargein_stopped:
                bargein_stopped = True
                t_stopped = time.time()
                print(f"[TEST 8] Barge-in confirmed! Bot stopped speaking at {t_stopped:.2f} (cutoff latency: {t_stopped - t_interrupt:.2f}s)")

        print("[TEST 8] Waiting 14s for bot response to interruption...")
        await asyncio.sleep(14.0)
        print("[TEST 8 COMPLETE]")

        # TEST 9: END CALL
        print("\n--- TEST 9: END CALL ---")
        print("[TEST 9] Sending: 'Bas itna hi, thank you.'")
        track.queue_file("/tmp/vaani_test_inputs/test9_end.wav")
        while track.playing:
            await asyncio.sleep(0.2)
            
        print("[TEST 9] User speech finished. Waiting 12s for final goodbye...")
        await asyncio.sleep(12.0)
        print("[TEST 9 COMPLETE]")

        await pc.close()
        print(f"[DONE] Completed Run {run_id}")
        with open("/tmp/bargein_end_run_id.txt", "w") as f:
            f.write(str(run_id))

if __name__ == "__main__":
    asyncio.run(main())
