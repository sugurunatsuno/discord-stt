# stt.py
import sys, json, os, time, re
from faster_whisper import WhisperModel

def transcribe(path: str):
    model_name = os.getenv("WHISPER_MODEL", "large-v3-turbo")
    device = os.getenv("WHISPER_DEVICE", "cpu")
    compute = os.getenv("WHISPER_PRECISION", "int8")
    lang = os.getenv("WHISPER_LANG", "ja")
    vad_ms = int(os.getenv("WHISPER_VAD_MS", "600"))

    model = WhisperModel(model_name, device=device, compute_type=compute)
    segments, info = model.transcribe(
        path,
        language=lang,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=vad_ms),
        beam_size=1,
        temperature=0.2,
    )

    parts = []
    for s in segments:
        t = (s.text or "").strip()
        if t:
            parts.append(t)
    text = " ".join(parts).strip()

    # ===== 無音/短文なら "ok=Trueだがtext=''" として返し、Node側でスキップ =====
    norm = re.sub(r'[ \t\n\r\u3000]+', ' ', text)
    norm = re.sub(r'[。、．，・!！?？…—\-\(\)\[\]{}"\'「」『』:：;；、｡､・〜~^]', '', norm).strip().lower()
    if len(norm) < 3:
        return dict(ok=True, language=info.language, duration=info.duration, text="")

    return dict(ok=True, language=info.language, duration=info.duration, text=text)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "no input"}))
        sys.exit(1)
    infile = sys.argv[1]

    # 書き込み完了待ち
    for _ in range(10):
        try:
            s1 = os.path.getsize(infile)
            time.sleep(0.05)
            s2 = os.path.getsize(infile)
            if s1 == s2 and s2 > 200:
                break
        except FileNotFoundError:
            time.sleep(0.05)

    last_err = None
    for _ in range(2):
        try:
            out = transcribe(infile)
            print(json.dumps(out, ensure_ascii=False))
            return
        except Exception as e:
            last_err = str(e)
            time.sleep(0.3)

    print(json.dumps({"ok": False, "error": last_err or "unknown"}))

if __name__ == "__main__":
    main()
