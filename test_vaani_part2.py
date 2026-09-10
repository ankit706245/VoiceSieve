import asyncio, json, uuid, wave, io, time, os, sys
import aiohttp, websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import AudioFrame
import numpy as np

async def main():
    email = sys.argv[1]
    password = sys.argv[2]
    
    print("=== STARTING VAANI TESTS 5 TO 9 ===")
    
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://localhost:8000/api/v1/auth/login",
            json={"email": email, "password": password}
        ) as resp:
            data = await resp.json()
            tok = data["token"]

        async with session.post(
            "http://localhost:8000/api/v1/workflow/3/runs",
            headers={"Authorization": f"Bearer {tok}"},
            json={"name": f"vaani-tests-5-9-{uuid.uuid4().hex[:6]}", "mode": "smallwebrtc"}
        ) as resp:
            run_data = await resp.json()
            run_id = run_data["id"]
            print(f"[RUN] Created smallwebrtc run: id={run_id}")

    ws_url = f"ws://localhost:8000/api/v1/ws/signaling/3/{run_id}?token={tok}"
    async with websockets.connect(ws_url) as ws:
        pc = RTCPeerConnection()
        pc_id = f"test_pc_{uuid.uuid4().hex[:8]}"
        
        class DynamicAudioTrack(MediaStreamTrack):
            kind = "audio"
            def __init__(self):
                super().__init__()
                self.time = 0
                self.sample_rate = 16000
                self.samples = 160
                self.queue = asyncio.Queue()
                self.playing_file = False
                
            def queue_wav(self, path):
                print(f"[TRACK] Queueing WAV: {path}")
                with wave.open(path, 'rb') as w:
                    raw = w.readframes(w.getnframes())
                chunk_size = 320
                for i in range(0, len(raw), chunk_size):
                    chunk = raw[i:i+chunk_size]
                    if len(chunk) < chunk_size:
                        chunk = chunk.ljust(chunk_size, b'\x00')
                    self.queue.put_nowait(chunk)
                print(f"[TRACK] Queued {self.queue.qsize()} chunks ({(self.queue.qsize()*10)/1000:.1f}s)")
                
            async def recv(self):
                await asyncio.sleep(0.01)
                if not self.queue.empty():
                    raw_bytes = self.queue.get_nowait()
                    data = np.frombuffer(raw_bytes, dtype=np.int16)
                    self.playing_file = True
                else:
                    data = np.zeros(self.samples, dtype=np.int16)
                    self.playing_file = False
                frame = AudioFrame.from_ndarray(data.reshape(1, -1), format="s16", layout="mono")
                frame.sample_rate = self.sample_rate
                frame.pts = self.time
                self.time += self.samples
                return frame

        audio_track = DynamicAudioTrack()
        pc.addTrack(audio_track)
        
        received_frames = []
        is_bot_speaking = False
        speaking_transitions = []
        
        @pc.on("track")
        def on_track(track):
            if track.kind == "audio":
                asyncio.create_task(collect_bot_audio(track))
                
        async def collect_bot_audio(track):
            nonlocal is_bot_speaking
            silence_counter = 0
            while True:
                try:
                    f = await track.recv()
                    arr = f.to_ndarray()
                    received_frames.append(arr.tobytes())
                    energy = np.abs(arr).mean()
                    if energy > 250:
                        if not is_bot_speaking:
                            is_bot_speaking = True
                            speaking_transitions.append(("bot_started", time.time()))
                            print(f"\n>>> [BOT STARTED SPEAKING] energy={energy:.0f}")
                        silence_counter = 0
                    else:
                        silence_counter += 1
                        if silence_counter > 40 and is_bot_speaking:
                            is_bot_speaking = False
                            speaking_transitions.append(("bot_stopped", time.time()))
                            print(f"\n<<< [BOT STOPPED SPEAKING]")
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
            elif msg.get("type") == "error":
                print("[SIGNALING ERROR]", msg)
                return

        # 0. Wait for initial Greeting
        print("\n--- STAGE 0: Waiting for Initial Greeting ---")
        await asyncio.sleep(8.0)
        print("[STAGE 0] Greeting completed.")

        # Test 5: APPOINTMENT
        print("\n--- TEST 5: APPOINTMENT ---")
        audio_track.queue_wav("/tmp/vaani_test_inputs/test5_appointment.wav")
        # Wait for user speech to finish
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("[TEST 5] Audio sent. Waiting 14s for bot response & playback...")
        await asyncio.sleep(14.0)

        # Test 6: UNKNOWN INFORMATION
        print("\n--- TEST 6: UNKNOWN INFORMATION ---")
        audio_track.queue_wav("/tmp/vaani_test_inputs/test6_unknown.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("[TEST 6] Audio sent. Waiting 14s for bot response & playback...")
        await asyncio.sleep(14.0)

        # Test 7: CALLBACK
        print("\n--- TEST 7: CALLBACK ---")
        audio_track.queue_wav("/tmp/vaani_test_inputs/test7_callback.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("[TEST 7] Audio sent. Waiting 14s for bot response & playback...")
        await asyncio.sleep(14.0)

        # Test 8: INTERRUPTION / BARGE-IN
        print("\n--- TEST 8: INTERRUPTION / BARGE-IN ---")
        # Trigger bot speech with a question
        audio_track.queue_wav("/tmp/vaani_test_inputs/test2_business.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        # Wait for bot to start speaking
        t_wait = time.time()
        while time.time() - t_wait < 8 and not is_bot_speaking:
            await asyncio.sleep(0.2)
        print("[TEST 8] Bot speaking! Letting bot speak for 1.2s before interrupting...")
        await asyncio.sleep(1.2)
        t_interrupt = time.time()
        print(f">>> [TEST 8] SENDING BARGE-IN INTERRUPTION SPEECH at {t_interrupt:.2f}")
        audio_track.queue_wav("/tmp/vaani_test_inputs/test8_bargein.wav")
        # Monitor bot stopping
        bargein_stopped = False
        t_stopped = None
        while audio_track.playing_file:
            await asyncio.sleep(0.1)
            if not is_bot_speaking and not bargein_stopped:
                bargein_stopped = True
                t_stopped = time.time()
                print(f"[TEST 8] Barge-in cutoff detected! Latency: {t_stopped - t_interrupt:.2f}s")
        print("[TEST 8] Waiting 15s for bot response to interruption...")
        await asyncio.sleep(15.0)

        # Test 9: END CALL
        print("\n--- TEST 9: END CALL ---")
        audio_track.queue_wav("/tmp/vaani_test_inputs/test9_end.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("[TEST 9] Audio sent. Waiting 10s for final goodbye...")
        await asyncio.sleep(10.0)

        print("\n--- ALL TESTS COMPLETED ---")
        await pc.close()
        print(f"[DONE] Finished run {run_id}")
        with open("/tmp/part2_run_id.txt", "w") as f:
            f.write(str(run_id))

if __name__ == "__main__":
    asyncio.run(main())
