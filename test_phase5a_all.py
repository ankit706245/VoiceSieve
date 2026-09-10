import asyncio, json, uuid, wave, io, time, os, sys
import aiohttp, websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import AudioFrame
import numpy as np

async def run_scenario(email, password, scenario_name, wav_path, wait_after_audio=14.0):
    print(f"\n=======================================================")
    print(f"RUNNING SCENARIO: {scenario_name}")
    print(f"Input Audio: {wav_path}")
    print(f"=======================================================")
    
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
            json={"name": f"phase5a-{scenario_name}-{uuid.uuid4().hex[:6]}", "mode": "smallwebrtc"}
        ) as resp:
            run_data = await resp.json()
            run_id = run_data["id"]
            print(f"[RUN] Created run_id: {run_id}")

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
        
        is_bot_speaking = False
        
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
                    energy = np.abs(arr).mean()
                    if energy > 250:
                        if not is_bot_speaking:
                            is_bot_speaking = True
                            print(f">>> [BOT SPEAKING] energy={energy:.0f}")
                        silence_counter = 0
                    else:
                        silence_counter += 1
                        if silence_counter > 30 and is_bot_speaking:
                            is_bot_speaking = False
                            print(f"<<< [BOT FINISHED]")
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
                return None

        # 1. Wait for Greeting
        print("[STEP 1] Waiting 7s for initial greeting...")
        await asyncio.sleep(7.0)
        
        # 2. Send test input audio
        print(f"[STEP 2] Sending test input: {wav_path}")
        audio_track.queue_wav(wav_path)
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("[STEP 2] User audio sent.")

        # 3. Wait for bot response
        print(f"[STEP 3] Waiting {wait_after_audio}s for bot response...")
        await asyncio.sleep(wait_after_audio)

        # 4. Close call cleanly
        print("[STEP 4] Closing WebRTC connection to trigger extraction...")
        await pc.close()

    print("[STEP 5] Waiting 5s for DB write...")
    await asyncio.sleep(5.0)
    print(f"[SUCCESS] Scenario {scenario_name} completed with run_id: {run_id}")
    return run_id

async def main():
    email = sys.argv[1]
    password = sys.argv[2]
    
    scenarios = [
        ("test2_lead_qual", "/tmp/vaani_phase5_inputs/test2_lead_qual.wav", 14.0),
        ("test3_callback", "/tmp/vaani_phase5_inputs/test3_callback.wav", 14.0),
        ("test4_appointment", "/tmp/vaani_phase5_inputs/test4_appointment.wav", 14.0),
        ("test5_optout", "/tmp/vaani_phase5_inputs/test5_optout.wav", 14.0)
    ]
    
    completed_runs = {}
    for name, wav, wait_time in scenarios:
        run_id = await run_scenario(email, password, name, wav, wait_time)
        completed_runs[name] = run_id
        # small pause between runs
        await asyncio.sleep(2.0)
        
    print("\n=======================================================")
    print("ALL SCENARIOS COMPLETED:")
    print(json.dumps(completed_runs, indent=2))
    print("=======================================================")

if __name__ == "__main__":
    asyncio.run(main())
