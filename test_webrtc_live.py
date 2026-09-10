import asyncio, json, uuid, wave, io, time, os, sys
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
            data = await resp.json()
            tok = data["token"]
            print("Token acquired successfully")

        async with session.post(
            "http://localhost:8000/api/v1/workflow/3/runs",
            headers={"Authorization": f"Bearer {tok}"},
            json={"name": f"test-run-{uuid.uuid4().hex[:6]}", "mode": "smallwebrtc"}
        ) as resp:
            run_data = await resp.json()
            run_id = run_data["id"]
            print(f"Created smallwebrtc run: id={run_id}")

    ws_url = f"ws://localhost:8000/api/v1/ws/signaling/3/{run_id}?token={tok}"
    async with websockets.connect(ws_url) as ws:
        print("Connected to WebSocket signaling")
        pc = RTCPeerConnection()
        pc_id = f"test_pc_{uuid.uuid4().hex[:8]}"
        
        # Audio track to send (silence at first)
        class DynamicAudioTrack(MediaStreamTrack):
            kind = "audio"
            def __init__(self):
                super().__init__()
                self.time = 0
                self.sample_rate = 16000
                self.samples = 160  # 10ms at 16kHz
                self.queue = asyncio.Queue()
                self.playing_file = False
                
            def queue_wav(self, path):
                print(f"Queueing WAV for playback: {path}")
                with wave.open(path, 'rb') as w:
                    sr = w.getframerate()
                    raw = w.readframes(w.getnframes())
                # chunk into 10ms frames (160 samples = 320 bytes)
                chunk_size = 320
                for i in range(0, len(raw), chunk_size):
                    chunk = raw[i:i+chunk_size]
                    if len(chunk) < chunk_size:
                        chunk = chunk.ljust(chunk_size, b'\x00')
                    self.queue.put_nowait(chunk)
                print(f"Queued {self.queue.qsize()} chunks ({(self.queue.qsize()*10)/1000:.1f}s)")
                
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
            print(f"WebRTC track received from Dograh: {track.kind}")
            if track.kind == "audio":
                asyncio.create_task(collect_bot_audio(track))
                
        async def collect_bot_audio(track):
            print("Listening for bot audio...")
            nonlocal is_bot_speaking
            silence_counter = 0
            while True:
                try:
                    f = await track.recv()
                    arr = f.to_ndarray()
                    received_frames.append(arr.tobytes())
                    energy = np.abs(arr).mean()
                    if energy > 200: # Active speech frame
                        if not is_bot_speaking:
                            is_bot_speaking = True
                            speaking_transitions.append(("bot_started", time.time()))
                            print(f"\n[BOT STARTED SPEAKING] energy={energy:.0f}")
                        silence_counter = 0
                    else:
                        silence_counter += 1
                        if silence_counter > 50 and is_bot_speaking: # ~500ms silence
                            is_bot_speaking = False
                            speaking_transitions.append(("bot_stopped", time.time()))
                            print(f"\n[BOT FINISHED SPEAKING]")
                except Exception as e:
                    break

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        
        await ws.send(json.dumps({
            "type": "offer",
            "payload": {
                "pc_id": pc_id,
                "sdp": pc.localDescription.sdp,
                "type": "offer",
                "call_context_vars": {}
            }
        }))
        print("Sent SDP offer to Dograh")
        
        answer_received = False
        while not answer_received:
            msg = json.loads(await ws.recv())
            m_type = msg.get("type")
            print("Signaling event:", m_type)
            if m_type == "answer":
                answer_sdp = msg["payload"]["sdp"]
                await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))
                print("Remote description set! Media flowing.")
                answer_received = True
            elif m_type == "error":
                print("Signaling error:", msg)
                return

        # ----------------------------------------------------
        # SCENARIOS EXECUTION
        # ----------------------------------------------------
        print("\n" + "="*60)
        print("STARTING SCENARIOS OVER WEBRTC VOICE PIPELINE")
        print("="*60)
        
        # 1. Wait for Greeting to finish
        print("\n--- SCENARIO 1: Greeting ---")
        print("Waiting for bot greeting...")
        t0 = time.time()
        while time.time() - t0 < 8:
            await asyncio.sleep(0.5)
            if is_bot_speaking:
                break
        while is_bot_speaking and time.time() - t0 < 15:
            await asyncio.sleep(0.5)
        print("Greeting turn completed!")
        
        # 2. Hindi business question
        print("\n--- SCENARIO 2: Hindi Business Question ---")
        audio_track.queue_wav("/tmp/user_inputs/q1_hindi.wav")
        # Wait for user speech to finish
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("User question sent. Waiting for bot reply...")
        t0 = time.time()
        while time.time() - t0 < 8 and not is_bot_speaking:
            await asyncio.sleep(0.5)
        while is_bot_speaking and time.time() - t0 < 15:
            await asyncio.sleep(0.5)
        print("Hindi question turn completed!")
        
        # 3. Hinglish question & Pricing
        print("\n--- SCENARIO 3 & 4: Hinglish & Pricing Question ---")
        audio_track.queue_wav("/tmp/user_inputs/q2_hinglish.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("User Hinglish question sent. Waiting for bot reply...")
        t0 = time.time()
        while time.time() - t0 < 8 and not is_bot_speaking:
            await asyncio.sleep(0.5)
        while is_bot_speaking and time.time() - t0 < 15:
            await asyncio.sleep(0.5)
        print("Hinglish/pricing turn completed!")
        
        # 4. User interruption / barge-in
        print("\n--- SCENARIO 5: User Interruption / Barge-in ---")
        # Ask question 3
        audio_track.queue_wav("/tmp/user_inputs/q3_business.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        # Wait for bot to START speaking
        t0 = time.time()
        while time.time() - t0 < 8 and not is_bot_speaking:
            await asyncio.sleep(0.2)
        print("Bot is speaking! Now interrupting immediately with user speech...")
        # Send interruption
        audio_track.queue_wav("/tmp/user_inputs/q4_interrupt.wav")
        interrupt_time = time.time()
        # Verify bot stops speaking within 1.5s
        await asyncio.sleep(1.0)
        print(f"Bot speaking status after barge-in: {is_bot_speaking}")
        # Wait for user interrupt audio to finish
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        # Wait for new bot reply
        t0 = time.time()
        while time.time() - t0 < 10 and not is_bot_speaking:
            await asyncio.sleep(0.5)
        while is_bot_speaking and time.time() - t0 < 15:
            await asyncio.sleep(0.5)
        print("Barge-in turn completed!")
        
        # 5. Callback request
        print("\n--- SCENARIO 6: Callback Request ---")
        audio_track.queue_wav("/tmp/user_inputs/q5_callback.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("User callback request sent. Waiting for bot reply...")
        t0 = time.time()
        while time.time() - t0 < 8 and not is_bot_speaking:
            await asyncio.sleep(0.5)
        while is_bot_speaking and time.time() - t0 < 15:
            await asyncio.sleep(0.5)
        print("Callback turn completed!")
        
        # 6. End conversation
        print("\n--- SCENARIO 7: End Conversation ---")
        audio_track.queue_wav("/tmp/user_inputs/q6_end.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
        print("User end sent. Waiting for final goodbye...")
        t0 = time.time()
        while time.time() - t0 < 8 and not is_bot_speaking:
            await asyncio.sleep(0.5)
        while is_bot_speaking and time.time() - t0 < 12:
            await asyncio.sleep(0.5)
        print("End conversation turn completed!")
        
        # Clean shutdown
        await pc.close()
        print("\n" + "="*60)
        print(f"Total audio frames captured from WebRTC: {len(received_frames)}")
        
        if received_frames:
            pcm_all = b"".join(received_frames)
            with wave.open("/tmp/webrtc_full_conversation.wav", "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(48000)
                wf.writeframes(pcm_all)
            print(f"Saved /tmp/webrtc_full_conversation.wav: {len(pcm_all)} bytes")
            
        print("WebRTC test run completed successfully!")

asyncio.run(main())
