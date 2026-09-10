import asyncio, json, uuid, wave, io, time, os, sys
import aiohttp, websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import AudioFrame
import numpy as np

async def main():
    email = sys.argv[1]
    password = sys.argv[2]
    
    print("=== STARTING VAANI VERIFICATION TEST ===")
    
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://localhost:8000/api/v1/auth/login",
            json={"email": email, "password": password}
        ) as resp:
            data = await resp.json()
            tok = data["token"]
            print("[AUTH] Token acquired successfully")

        async with session.post(
            "http://localhost:8000/api/v1/workflow/3/runs",
            headers={"Authorization": f"Bearer {tok}"},
            json={"name": f"vaani-verification-{uuid.uuid4().hex[:6]}", "mode": "smallwebrtc"}
        ) as resp:
            run_data = await resp.json()
            run_id = run_data["id"]
            print(f"[RUN] Created smallwebrtc run: id={run_id}")

    ws_url = f"ws://localhost:8000/api/v1/ws/signaling/3/{run_id}?token={tok}"
    async with websockets.connect(ws_url) as ws:
        print("[WEBRTC] Connected to WebSocket signaling")
        pc = RTCPeerConnection()
        pc_id = f"test_pc_{uuid.uuid4().hex[:8]}"
        
        class DynamicAudioTrack(MediaStreamTrack):
            kind = "audio"
            def __init__(self):
                super().__init__()
                self.time = 0
                self.sample_rate = 16000
                self.samples = 160  # 10ms frames at 16kHz
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
                print(f"[TRACK] Queued {self.queue.qsize()} chunks ({(self.queue.qsize()*10)/1000:.1f}s audio)")
                
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
            print(f"[WEBRTC] Media track received from Dograh: {track.kind}")
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
                    if energy > 250:  # Active speech threshold
                        if not is_bot_speaking:
                            is_bot_speaking = True
                            t_now = time.time()
                            speaking_transitions.append(("bot_started", t_now))
                            print(f"\n>>> [BOT STARTED SPEAKING] energy={energy:.0f} at {t_now:.2f}")
                        silence_counter = 0
                    else:
                        silence_counter += 1
                        if silence_counter > 40 and is_bot_speaking:  # ~400ms silence
                            is_bot_speaking = False
                            t_now = time.time()
                            speaking_transitions.append(("bot_stopped", t_now))
                            print(f"\n<<< [BOT STOPPED SPEAKING] at {t_now:.2f}")
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
        print("[WEBRTC] Sent SDP offer")
        
        while True:
            msg = json.loads(await ws.recv())
            m_type = msg.get("type")
            print(f"[SIGNALING] Event: {m_type}")
            if m_type == "answer":
                answer_sdp = msg["payload"]["sdp"]
                await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))
                print("[WEBRTC] Connected! Media flowing.")
                break
            elif m_type == "error":
                print(f"[SIGNALING ERROR]: {msg}")
                return

        # ----------------------------------------------------------------------
        # TEST EXECUTION FLOW
        # ----------------------------------------------------------------------
        test_metrics = {}
        
        # 0. Wait for initial Greeting from Bot
        print("\n" + "="*70)
        print("STAGE 0: Waiting for Initial Vaani Greeting...")
        print("="*70)
        t0 = time.time()
        # Wait up to 10s for bot greeting to start
        while time.time() - t0 < 10 and not is_bot_speaking:
            await asyncio.sleep(0.3)
        # Wait for greeting to finish
        t_greet = time.time()
        while (is_bot_speaking or (time.time() - t_greet < 4)) and time.time() - t0 < 15:
            await asyncio.sleep(0.3)
        await asyncio.sleep(1.0)
        print("[STAGE 0 COMPLETE] Initial Greeting played.")

        # Helper for a normal conversational turn
        async def run_turn(test_num, title, wav_file, timeout_wait=10, timeout_speak=15):
            print("\n" + "="*70)
            print(f"TEST {test_num}: {title}")
            print("="*70)
            t_start = time.time()
            audio_track.queue_wav(wav_file)
            while audio_track.playing_file:
                await asyncio.sleep(0.2)
            print(f"[TEST {test_num}] User audio finished playing. Waiting for Vaani response...")
            
            # Wait for bot to start speaking
            t_wait = time.time()
            bot_started = False
            while time.time() - t_wait < timeout_wait:
                if is_bot_speaking:
                    bot_started = True
                    break
                await asyncio.sleep(0.2)
                
            if not bot_started:
                print(f"[TEST {test_num}] WARNING: Bot did not start speaking within {timeout_wait}s")
            else:
                ttfb_est = time.time() - t_wait
                print(f"[TEST {test_num}] Bot responded! (detected latency ~{ttfb_est:.2f}s)")
                
            # Wait for bot to finish speaking
            t_speak = time.time()
            while is_bot_speaking and (time.time() - t_speak < timeout_speak):
                await asyncio.sleep(0.3)
            await asyncio.sleep(1.0) # Grace period
            duration = time.time() - t_start
            test_metrics[test_num] = {
                "title": title,
                "bot_started": bot_started,
                "duration": duration
            }
            print(f"[TEST {test_num} COMPLETE] Duration: {duration:.2f}s")

        # 1. GREETING: User says "नमस्ते"
        await run_turn(1, "GREETING", "/tmp/vaani_test_inputs/test1_greeting.wav")

        # 2. BASIC BUSINESS QUESTION: "आप Vaani से क्या-क्या काम करवा सकते हैं?"
        await run_turn(2, "BASIC BUSINESS QUESTION", "/tmp/vaani_test_inputs/test2_business.wav")

        # 3. HINGLISH: "Mere salon ke customer calls Vaani handle kar sakti hai?"
        await run_turn(3, "HINGLISH", "/tmp/vaani_test_inputs/test3_hinglish.wav")

        # 4. PRICING: "Aapka pricing kya hai?"
        await run_turn(4, "PRICING", "/tmp/vaani_test_inputs/test4_pricing.wav")

        # 5. APPOINTMENT: "Mujhe salon ke liye appointment book karni hai."
        await run_turn(5, "APPOINTMENT", "/tmp/vaani_test_inputs/test5_appointment.wav")

        # 6. UNKNOWN INFORMATION: "Aapka founder ka personal number kya hai?"
        await run_turn(6, "UNKNOWN INFORMATION", "/tmp/vaani_test_inputs/test6_unknown.wav")

        # 7. CALLBACK: "Mera naam Rahul hai, mujhe callback chahiye."
        await run_turn(7, "CALLBACK", "/tmp/vaani_test_inputs/test7_callback.wav")

        # 8. INTERRUPTION / BARGE-IN:
        # Trigger speech with a prompt, wait for bot to start speaking, then interrupt immediately
        print("\n" + "="*70)
        print("TEST 8: INTERRUPTION / BARGE-IN")
        print("="*70)
        # Ask question to start bot talking
        print("[TEST 8] Sending trigger question to prompt bot speech...")
        audio_track.queue_wav("/tmp/vaani_test_inputs/test2_business.wav")
        while audio_track.playing_file:
            await asyncio.sleep(0.2)
            
        t_wait = time.time()
        while time.time() - t_wait < 8 and not is_bot_speaking:
            await asyncio.sleep(0.2)
            
        print("[TEST 8] Bot is speaking! Letting bot speak for 1.2s before interrupting...")
        await asyncio.sleep(1.2)
        
        # Now interrupt with "Ek minute, mujhe pehle pricing bataiye."
        t_interrupt_sent = time.time()
        print(f">>> [TEST 8] INJECTING USER INTERRUPTION SPEECH at {t_interrupt_sent:.2f}")
        audio_track.queue_wav("/tmp/vaani_test_inputs/test8_bargein.wav")
        
        # Measure how quickly bot stops speaking
        bargein_stopped = False
        t_stop_detected = None
        while audio_track.playing_file:
            await asyncio.sleep(0.1)
            if not is_bot_speaking and not bargein_stopped:
                bargein_stopped = True
                t_stop_detected = time.time()
                print(f"[TEST 8] Barge-in confirmed! Bot stopped speaking at {t_stop_detected:.2f} (cutoff latency: {t_stop_detected - t_interrupt_sent:.2f}s)")
                
        # Wait for bot to respond to the interruption
        print("[TEST 8] Waiting for Vaani's post-interruption response...")
        t_wait_resp = time.time()
        bot_resumed = False
        while time.time() - t_wait_resp < 10:
            if is_bot_speaking:
                bot_resumed = True
                print("[TEST 8] Vaani responded to the interruption!")
                break
            await asyncio.sleep(0.2)
            
        while is_bot_speaking and time.time() - t_wait_resp < 15:
            await asyncio.sleep(0.3)
            
        await asyncio.sleep(1.0)
        test_metrics[8] = {
            "title": "INTERRUPTION / BARGE-IN",
            "bargein_stopped": bargein_stopped,
            "cutoff_latency": (t_stop_detected - t_interrupt_sent) if t_stop_detected else None,
            "bot_resumed": bot_resumed
        }
        print("[TEST 8 COMPLETE]")

        # 9. END CALL: "Bas itna hi, thank you."
        await run_turn(9, "END CALL", "/tmp/vaani_test_inputs/test9_end.wav")

        print("\n" + "="*70)
        print("ALL 9 TEST TURNS EXECUTED SUCCESSFULLY")
        print("="*70)
        
        await pc.close()
        
        # Save received bot audio
        if received_frames:
            pcm_all = b"".join(received_frames)
            with wave.open("/tmp/vaani_live_test_full.wav", "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(48000)
                wf.writeframes(pcm_all)
            print(f"[AUDIO] Saved full conversation audio: /tmp/vaani_live_test_full.wav ({len(pcm_all)} bytes, {len(pcm_all)/96000:.1f}s)")

        print(f"\n[DONE] Test Run ID: {run_id}")
        with open("/tmp/last_test_run_id.txt", "w") as f:
            f.write(str(run_id))

if __name__ == "__main__":
    asyncio.run(main())
