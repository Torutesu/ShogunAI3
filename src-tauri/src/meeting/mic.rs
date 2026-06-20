//! Meeting audio capture: microphone (cpal) + system audio (loopback / ScreenCaptureKit)
//! with optional live Deepgram chunk transcription.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const MAX_MONO_FLOATS: usize = 48000 * 60 * 8;
const LIVE_CHUNK_SECS: u64 = 3;
const MIN_CHUNK_PCM_BYTES: usize = 16000 * 2;
const SYSTEM_SAMPLE_RATE: u32 = 48_000;

pub fn resample_f32_mono_to_pcm16_16k(input: &[f32], from_hz: u32) -> Vec<u8> {
    if input.is_empty() {
        return Vec::new();
    }
    let from = from_hz as f64;
    let to = 16000f64;
    let ratio = from / to;
    let out_n = ((input.len() as f64) / ratio).floor().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_n * 2);
    for j in 0..out_n {
        let t = j as f64 * ratio;
        let i0 = t.floor() as usize;
        let i1 = (i0 + 1).min(input.len().saturating_sub(1));
        let f = t - i0 as f64;
        let v = input[i0] as f64 * (1.0 - f) + input[i1] as f64 * f;
        let s = (v.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

pub(crate) struct SampleTrack {
    floats: Vec<f32>,
    sample_rate: u32,
    consumed: usize,
}

impl SampleTrack {
    fn new(sample_rate: u32) -> Self {
        Self {
            floats: Vec::new(),
            sample_rate,
            consumed: 0,
        }
    }

    pub(crate) fn take_chunk_pcm16(&mut self) -> Vec<u8> {
        if self.consumed >= self.floats.len() {
            return Vec::new();
        }
        let chunk = self.floats[self.consumed..].to_vec();
        self.consumed = self.floats.len();
        resample_f32_mono_to_pcm16_16k(&chunk, self.sample_rate)
    }

    fn drain_all_pcm16(&mut self) -> Vec<u8> {
        let all = std::mem::take(&mut self.floats);
        self.consumed = 0;
        resample_f32_mono_to_pcm16_16k(&all, self.sample_rate)
    }
}

pub struct StartOptions {
    pub meeting_id: Option<String>,
    pub live_stt: bool,
    pub capture_system: bool,
}

pub struct StopResult {
    pub mic_pcm: Vec<u8>,
    pub system_pcm: Vec<u8>,
}

struct ActiveRun {
    stop: Arc<AtomicBool>,
    mic_result_rx: Receiver<Result<Vec<u8>, String>>,
    system_buf: Option<Arc<Mutex<Vec<f32>>>>,
    meeting_id: Option<String>,
    system_mode: Option<String>,
    live_stt: bool,
}

pub struct MeetingMicController {
    inner: Mutex<Option<ActiveRun>>,
}

impl Default for MeetingMicController {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

pub fn default_input_device_label() -> Option<String> {
    let host = cpal::default_host();
    host.default_input_device()?.name().ok()
}

impl MeetingMicController {
    pub fn start(&self) -> Result<(), String> {
        self.start_with(
            None,
            StartOptions {
                meeting_id: None,
                live_stt: false,
                capture_system: true,
            },
        )
        .map(|_| ())
    }

    pub fn start_with(&self, app: Option<AppHandle>, opts: StartOptions) -> Result<Value, String> {
        let mut g = self.inner.lock().map_err(|e| e.to_string())?;
        if g.is_some() {
            return Err("meeting recording already running".to_string());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let (mic_result_tx, mic_result_rx) = mpsc::channel();
        let mic_track = Arc::new(Mutex::new(SampleTrack::new(48_000)));
        let mic_track2 = mic_track.clone();
        let stop_mic = stop.clone();
        std::thread::spawn(move || mic_capture_thread(stop_mic, mic_result_tx, mic_track2));

        let mut system_mode: Option<String> = None;
        let system_buf: Option<Arc<Mutex<Vec<f32>>>> = if opts.capture_system {
            let buf = Arc::new(Mutex::new(Vec::<f32>::new()));
            match crate::macos_system_audio::start_system_audio_capture(stop.clone(), buf.clone()) {
                Ok(label) => {
                    system_mode = Some(label);
                    Some(buf)
                }
                Err(e) => {
                    log::warn!("system audio unavailable: {}", e);
                    None
                }
            }
        } else {
            None
        };

        if let (Some(app_handle), Some(meeting_id)) = (app.as_ref(), opts.meeting_id.as_ref()) {
            if opts.live_stt && crate::meeting_stt::deepgram_api_key().is_some() {
                spawn_live_stt_worker(
                    app_handle.clone(),
                    meeting_id.clone(),
                    mic_track.clone(),
                    system_buf.clone(),
                    stop.clone(),
                );
            }
            if let Some(session) =
                app_handle.try_state::<crate::meeting_session::MeetingSessionState>()
            {
                let _ = session.touch_activity(meeting_id);
            }
        }

        *g = Some(ActiveRun {
            stop: stop.clone(),
            mic_result_rx,
            system_buf: system_buf.clone(),
            meeting_id: opts.meeting_id.clone(),
            system_mode: system_mode.clone(),
            live_stt: opts.live_stt,
        });

        Ok(json!({
          "ok": true,
          "mic_running": true,
          "system_running": system_mode.is_some(),
          "system_mode": system_mode,
          "meeting_id": opts.meeting_id,
          "live_stt": opts.live_stt,
        }))
    }

    pub fn stop(&self) -> Result<StopResult, String> {
        let ActiveRun {
            stop,
            mic_result_rx,
            system_buf,
            ..
        } = {
            let mut g = self.inner.lock().map_err(|e| e.to_string())?;
            g.take()
                .ok_or_else(|| "meeting recording is not running".to_string())?
        };
        stop.store(true, Ordering::Relaxed);
        let mic_pcm = match mic_result_rx.recv() {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err("mic thread disconnected".to_string()),
        };
        let system_pcm = system_buf
            .as_ref()
            .and_then(|b| b.lock().ok())
            .map(|f| resample_f32_mono_to_pcm16_16k(&f, SYSTEM_SAMPLE_RATE))
            .unwrap_or_default();
        Ok(StopResult {
            mic_pcm,
            system_pcm,
        })
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn status(&self) -> Value {
        let g = self.inner.lock().ok();
        match g.as_ref().and_then(|g| g.as_ref()) {
            Some(run) => json!({
              "mic_capture_running": true,
              "system_audio_running": run.system_mode.is_some(),
              "system_mode": run.system_mode,
              "meeting_id": run.meeting_id,
              "live_stt": run.live_stt,
            }),
            None => json!({
              "mic_capture_running": false,
              "system_audio_running": false,
            }),
        }
    }
}

fn spawn_live_stt_worker(
    app: AppHandle,
    meeting_id: String,
    mic_track: Arc<Mutex<SampleTrack>>,
    system_buf: Option<Arc<Mutex<Vec<f32>>>>,
    stop: Arc<AtomicBool>,
) {
    if crate::meeting_stt::deepgram_api_key().is_some()
        && crate::meeting_stt_live::streaming_enabled()
    {
        crate::meeting_stt_live::spawn_mic_stream(
            app.clone(),
            meeting_id.clone(),
            mic_track,
            stop.clone(),
        );
        if let Some(buf) = system_buf {
            crate::meeting_stt_live::spawn_system_stream(app, meeting_id, buf, stop);
        }
        return;
    }

    let mut sys_consumed: usize = 0;
    tauri::async_runtime::spawn(async move {
        let mut chunk_idx: u64 = 0;
        while !stop.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_secs(LIVE_CHUNK_SECS)).await;
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let offset_ms = chunk_idx * LIVE_CHUNK_SECS * 1000;
            chunk_idx += 1;

            let mic_pcm = mic_track
                .lock()
                .ok()
                .map(|mut t| t.take_chunk_pcm16())
                .unwrap_or_default();
            if mic_pcm.len() >= MIN_CHUNK_PCM_BYTES {
                match crate::meeting_stt::deepgram_transcribe_pcm16_16k(&mic_pcm).await {
                    Ok((text, conf)) if !text.trim().is_empty() => {
                        push_live_segment(
                            &app,
                            &meeting_id,
                            "self",
                            &text,
                            conf,
                            offset_ms,
                            offset_ms + LIVE_CHUNK_SECS * 1000,
                        );
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("live STT mic chunk: {}", e),
                }
            }

            if let Some(ref buf) = system_buf {
                let sys_pcm = {
                    let mut floats = buf.lock().ok();
                    floats.as_mut().map(|f| {
                        if sys_consumed >= f.len() {
                            return Vec::new();
                        }
                        let chunk = f[sys_consumed..].to_vec();
                        sys_consumed = f.len();
                        resample_f32_mono_to_pcm16_16k(&chunk, SYSTEM_SAMPLE_RATE)
                    })
                }
                .unwrap_or_default();
                if sys_pcm.len() >= MIN_CHUNK_PCM_BYTES {
                    match crate::meeting_stt::deepgram_transcribe_pcm16_16k(&sys_pcm).await {
                        Ok((text, conf)) if !text.trim().is_empty() => {
                            push_live_segment(
                                &app,
                                &meeting_id,
                                "other",
                                &text,
                                conf,
                                offset_ms,
                                offset_ms + LIVE_CHUNK_SECS * 1000,
                            );
                        }
                        Ok(_) => {}
                        Err(e) => log::warn!("live STT system chunk: {}", e),
                    }
                }
            }
        }
    });
}

fn push_live_segment(
    app: &AppHandle,
    meeting_id: &str,
    speaker: &str,
    text: &str,
    conf: f32,
    start_ms: u64,
    end_ms: u64,
) {
    let Some(session) = app.try_state::<crate::meeting_session::MeetingSessionState>() else {
        return;
    };
    let seg_id = crate::meeting_store::new_uuid();
    let seg = json!({
      "segment_id": seg_id,
      "meeting_id": meeting_id,
      "start_ms": start_ms,
      "end_ms": end_ms,
      "speaker": speaker,
      "text": text,
      "confidence": conf as f64,
      "is_final": true,
    });
    if let Err(e) = session.push_live_segment(meeting_id, seg) {
        log::warn!("push_live_segment: {}", e);
    }
}

fn mic_capture_thread(
    stop: Arc<AtomicBool>,
    result_tx: Sender<Result<Vec<u8>, String>>,
    track: Arc<Mutex<SampleTrack>>,
) {
    let host = cpal::default_host();
    let device = match host.default_input_device() {
        Some(d) => d,
        None => {
            let _ = result_tx.send(Err("no default input device".to_string()));
            return;
        }
    };
    let dev_name = device.name().unwrap_or_else(|_| "default mic".to_string());
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = result_tx.send(Err(format!("input config: {e}")));
            return;
        }
    };
    let sample_format = supported.sample_format();
    let cfg: StreamConfig = supported.config();
    let channels = cfg.channels.max(1) as usize;
    let sample_rate = cfg.sample_rate.0;
    if let Ok(mut t) = track.lock() {
        t.sample_rate = sample_rate;
    }

    let track2 = track.clone();
    let err_fn = |e: cpal::StreamError| log::warn!("mic cpal error: {}", e);
    let stream_result = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &cfg,
            move |data: &[f32], _: &_| append_f32(&track2, data, channels),
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            &cfg,
            move |data: &[i16], _: &_| append_i16(&track2, data, channels),
            err_fn,
            None,
        ),
        other => {
            let _ = result_tx.send(Err(format!("unsupported sample format {:?}", other)));
            return;
        }
    };
    let stream = match stream_result {
        Ok(s) => s,
        Err(e) => {
            let _ = result_tx.send(Err(e.to_string()));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = result_tx.send(Err(format!("play: {e}")));
        return;
    }
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(50));
    }
    drop(stream);
    let pcm = track
        .lock()
        .ok()
        .map(|mut t| t.drain_all_pcm16())
        .unwrap_or_default();
    log::info!("meeting_mic: {} PCM16 bytes from {}", pcm.len(), dev_name);
    let _ = result_tx.send(Ok(pcm));
}

fn append_f32(track: &Arc<Mutex<SampleTrack>>, data: &[f32], channels: usize) {
    if let Ok(mut t) = track.lock() {
        if t.floats.len() >= MAX_MONO_FLOATS {
            return;
        }
        for frame in data.chunks(channels) {
            t.floats.push(frame.first().copied().unwrap_or(0.0));
        }
    }
}

fn append_i16(track: &Arc<Mutex<SampleTrack>>, data: &[i16], channels: usize) {
    if let Ok(mut t) = track.lock() {
        if t.floats.len() >= MAX_MONO_FLOATS {
            return;
        }
        for frame in data.chunks(channels) {
            let s = frame.first().copied().unwrap_or(0) as f32 / 32768.0;
            t.floats.push(s);
        }
    }
}
