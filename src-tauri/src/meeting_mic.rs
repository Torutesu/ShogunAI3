//! Default microphone capture via **cpal** (mono float → resample to 16 kHz PCM16 LE for Deepgram).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;

const MAX_MONO_FLOATS: usize = 48000 * 60 * 8; // ~8 min @ 48k mono f32 cap

fn resample_f32_mono_to_pcm16_16k(input: &[f32], from_hz: u32) -> Vec<u8> {
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

struct MicRun {
  stop_tx: Sender<()>,
  result_rx: Receiver<Result<Vec<u8>, String>>,
}

pub struct MeetingMicController {
  inner: Mutex<Option<MicRun>>,
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
    let mut g = self.inner.lock().map_err(|e| e.to_string())?;
    if g.is_some() {
      return Err("microphone capture already running".to_string());
    }
    let (stop_tx, stop_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    std::thread::spawn(move || {
      capture_thread(stop_rx, result_tx);
    });
    *g = Some(MicRun {
      stop_tx,
      result_rx,
    });
    Ok(())
  }

  pub fn stop(&self) -> Result<Vec<u8>, String> {
    let MicRun {
      stop_tx,
      result_rx,
    } = {
      let mut g = self.inner.lock().map_err(|e| e.to_string())?;
      g.take().ok_or_else(|| "microphone capture is not running".to_string())?
    };
    let _ = stop_tx.send(());
    match result_rx.recv() {
      Ok(Ok(bytes)) => Ok(bytes),
      Ok(Err(e)) => Err(e),
      Err(_) => Err("mic thread disconnected".to_string()),
    }
  }

  pub fn is_running(&self) -> bool {
    self
      .inner
      .lock()
      .map(|g| g.is_some())
      .unwrap_or(false)
  }
}

fn capture_thread(stop_rx: Receiver<()>, result_tx: Sender<Result<Vec<u8>, String>>) {
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

  let mono_buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<f32>::new()));
  let mono2 = mono_buf.clone();

  let err_fn = |e: cpal::StreamError| {
    log::warn!("cpal stream error: {}", e);
  };

  let stream_result = match sample_format {
    SampleFormat::F32 => device.build_input_stream(
      &cfg,
      move |data: &[f32], _: &_| {
        if let Ok(mut g) = mono2.lock() {
          if g.len() >= MAX_MONO_FLOATS {
            return;
          }
          for frame in data.chunks(channels) {
            g.push(frame.get(0).copied().unwrap_or(0.0));
          }
        }
      },
      err_fn,
      None,
    ),
    SampleFormat::I16 => device.build_input_stream(
      &cfg,
      move |data: &[i16], _: &_| {
        if let Ok(mut g) = mono2.lock() {
          if g.len() >= MAX_MONO_FLOATS {
            return;
          }
          for frame in data.chunks(channels) {
            let s = frame.get(0).copied().unwrap_or(0) as f32 / 32768.0;
            g.push(s);
          }
        }
      },
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

  let _ = stop_rx.recv();
  drop(stream);

  let floats: Vec<f32> = match mono_buf.lock() {
    Ok(g) => g.clone(),
    Err(_) => {
      let _ = result_tx.send(Err("mono buffer poisoned".to_string()));
      return;
    }
  };
  let pcm = resample_f32_mono_to_pcm16_16k(&floats, sample_rate);
  log::info!(
    "meeting_mic: {} frames @ {} Hz → {} PCM16 bytes ({})",
    floats.len(),
    sample_rate,
    pcm.len(),
    dev_name
  );
  let _ = result_tx.send(Ok(pcm));
}
