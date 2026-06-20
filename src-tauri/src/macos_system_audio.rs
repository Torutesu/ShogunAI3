//! macOS system audio capture: loopback input devices (BlackHole, etc.) or
//! ScreenCaptureKit display audio (macOS 13+, requires Screen Recording permission).

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const MAX_MONO_FLOATS: usize = 48000 * 60 * 8;

fn loopback_device_name(name: &str) -> bool {
    let n = name.to_lowercase();
    [
        "blackhole",
        "loopback",
        "soundflower",
        "monitor of",
        "aggregate",
        "virtual",
        "teams audio",
        "zoomaudio",
    ]
    .iter()
    .any(|k| n.contains(k))
}

pub fn find_loopback_input_device() -> Option<(cpal::Device, String)> {
    let host = cpal::default_host();
    for device in host.input_devices().ok()? {
        let name = device.name().unwrap_or_default();
        if loopback_device_name(&name) {
            return Some((device, name));
        }
    }
    None
}

fn push_mono_samples(buf: &Arc<Mutex<Vec<f32>>>, data: &[f32], channels: usize) {
    if let Ok(mut g) = buf.lock() {
        if g.len() >= MAX_MONO_FLOATS {
            return;
        }
        for frame in data.chunks(channels.max(1)) {
            g.push(frame.first().copied().unwrap_or(0.0));
        }
    }
}

fn push_mono_i16(buf: &Arc<Mutex<Vec<f32>>>, data: &[i16], channels: usize) {
    if let Ok(mut g) = buf.lock() {
        if g.len() >= MAX_MONO_FLOATS {
            return;
        }
        for frame in data.chunks(channels.max(1)) {
            let s = frame.first().copied().unwrap_or(0) as f32 / 32768.0;
            g.push(s);
        }
    }
}

fn cpal_loopback_thread(
    device: cpal::Device,
    dev_name: String,
    stop: Arc<AtomicBool>,
    mono_buf: Arc<Mutex<Vec<f32>>>,
) {
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("loopback input config: {e}");
            return;
        }
    };
    let sample_format = supported.sample_format();
    let cfg: StreamConfig = supported.config();
    let channels = cfg.channels.max(1) as usize;
    let mono2 = mono_buf.clone();
    let err_fn = |e: cpal::StreamError| log::warn!("system audio cpal error: {}", e);
    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            &cfg,
            move |data: &[f32], _: &_| push_mono_samples(&mono2, data, channels),
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            &cfg,
            move |data: &[i16], _: &_| push_mono_i16(&mono2, data, channels),
            err_fn,
            None,
        ),
        other => {
            log::warn!("unsupported loopback format {:?}", other);
            return;
        }
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            log::warn!("loopback stream build: {e}");
            return;
        }
    };
    if let Err(e) = stream.play() {
        log::warn!("loopback stream play: {e}");
        return;
    }
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    drop(stream);
    log::info!("macos_system_audio: loopback stopped ({})", dev_name);
}

#[cfg(target_os = "macos")]
fn append_sck_audio_samples(
    sample: &screencapturekit::prelude::CMSampleBuffer,
    buf: &Arc<Mutex<Vec<f32>>>,
) {
    let Some(list) = sample.audio_buffer_list() else {
        return;
    };
    let count = list.num_buffers();
    for i in 0..count {
        let Some(buffer) = list.buffer(i) else {
            continue;
        };
        let bytes = buffer.data();
        if bytes.len() < 4 {
            continue;
        }
        if let Ok(mut g) = buf.lock() {
            for chunk in bytes.chunks_exact(4) {
                if g.len() >= MAX_MONO_FLOATS {
                    break;
                }
                let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                g.push(v);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn sck_thread(stop: Arc<AtomicBool>, mono_buf: Arc<Mutex<Vec<f32>>>) {
    use screencapturekit::prelude::*;

    let Ok(content) = SCShareableContent::get() else {
        log::warn!("SCK: failed to get shareable content");
        return;
    };
    let Some(display) = content.displays().into_iter().next() else {
        log::warn!("SCK: no display");
        return;
    };
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();
    let config = SCStreamConfiguration::new()
        .with_captures_audio(true)
        .with_width(2)
        .with_height(2)
        .with_pixel_format(PixelFormat::BGRA);
    let buf = mono_buf.clone();
    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(
        move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
            if of_type == SCStreamOutputType::Audio {
                append_sck_audio_samples(&sample, &buf);
            }
        },
        SCStreamOutputType::Audio,
    );
    if let Err(e) = stream.start_capture() {
        log::warn!("SCK start: {e}");
        return;
    }
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = stream.stop_capture();
    log::info!("macos_system_audio: SCK stopped");
}

/// Start system-audio capture on a background thread.
pub fn start_system_audio_capture(
    stop: Arc<AtomicBool>,
    mono_buf: Arc<Mutex<Vec<f32>>>,
) -> Result<String, String> {
    if let Some((device, name)) = find_loopback_input_device() {
        let label = name.clone();
        let stop2 = stop.clone();
        let buf = mono_buf.clone();
        std::thread::spawn(move || cpal_loopback_thread(device, name, stop2, buf));
        return Ok(format!("loopback: {label}"));
    }

    #[cfg(target_os = "macos")]
    {
        let stop2 = stop.clone();
        let buf = mono_buf.clone();
        std::thread::spawn(move || sck_thread(stop2, buf));
        return Ok("ScreenCaptureKit display audio".to_string());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (stop, mono_buf);
        Err("no loopback input device found".to_string())
    }
}
