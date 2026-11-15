// Joins a LiveKit room and publishes the pipeline's pre-encoded H.264 as a
// screen-share track. Reports progress as one JSON object per line on stdout.

use crate::pipeline::{self, Config};
use anyhow::{anyhow, Result};
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoderBackend, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;

fn emit(v: serde_json::Value) {
    println!("{v}");
}

pub async fn run(cfg: Config, url: String, token: String) -> Result<()> {
    let (w, h) = pipeline::probe_size(&cfg)?;
    let (room, mut events) = Room::connect(&url, &token, RoomOptions::default())
        .await
        .map_err(|e| anyhow!("connect failed: {e}"))?;
    emit(json!({ "event": "connected", "identity": room.local_participant().identity().as_str() }));

    let resolution = VideoResolution { width: w, height: h };
    let source = NativeVideoSource::new_encoded(resolution.clone());
    let track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(source.clone()));
    let options = TrackPublishOptions {
        video_codec: VideoCodec::H264,
        video_encoder: VideoEncoderBackend::PreEncoded,
        simulcast: false,
        source: TrackSource::Screenshare,
        // Without this the SDK picks a ~3 Mbps screenshare preset as the ceiling of
        // the server's bandwidth estimate. The real cap is applied by the helper.
        video_encoding: Some(VideoEncoding { max_bitrate: 20_000_000, max_framerate: cfg.fps as f64 }),
        ..Default::default()
    };
    room.local_participant()
        .publish_track(LocalTrack::Video(track), options)
        .await
        .map_err(|e| anyhow!("publish failed: {e}"))?;

    let sink_source = source.clone();
    let sink_res = resolution.clone();
    let handle = pipeline::start(
        cfg.clone(),
        Box::new(move |f| {
            let frame = EncodedVideoFrame {
                codec: EncodedVideoCodec::H264,
                payload: &f.data,
                timestamp_us: f.ts_us,
                frame_type: if f.key { EncodedFrameType::Key } else { EncodedFrameType::Delta },
                resolution: sink_res.clone(),
                frame_metadata: None,
            };
            let _ = sink_source.capture_encoded_frame(&frame);
        }),
    )?;
    emit(json!({ "event": "started", "width": handle.width, "height": handle.height, "encoder": handle.encoder }));

    let ctl = handle.ctl.clone();
    // The server's bandwidth estimate starts low and ramps up; starting the encoder at
    // the full rate queues the first big frames in the sender's pacer and the viewer
    // drops frames to catch up. Start modestly and let the estimate raise it.
    ctl.kbps.store(cfg.kbps.min(5000), Ordering::Relaxed);
    let mut max_kbps = cfg.kbps;
    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    let mut last_stats = std::time::Instant::now();
    let mut prev = (0u64, 0u64, 0u64, 0u64);
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if source.take_keyframe_request() {
                    ctl.force_key.store(true, Ordering::Relaxed);
                }
                if let Some(t) = source.take_rate_control_request() {
                    let kbps = (((t.target_bitrate_bps / 1000) as f64 * 0.92) as u32).clamp(1500, max_kbps.max(1500));
                    ctl.kbps.store(kbps, Ordering::Relaxed);
                }
                if last_stats.elapsed() >= Duration::from_secs(1) {
                    let dt = last_stats.elapsed().as_secs_f64();
                    last_stats = std::time::Instant::now();
                    let c = &ctl.counters;
                    let (cap, enc, bytes, lat) = (
                        c.captured.load(Ordering::Relaxed),
                        c.encoded.load(Ordering::Relaxed),
                        c.bytes.load(Ordering::Relaxed),
                        c.lat_us_sum.load(Ordering::Relaxed),
                    );
                    let de = enc - prev.1;
                    emit(json!({
                        "event": "stats",
                        "captured_fps": ((cap - prev.0) as f64 / dt).round(),
                        "encoded_fps": (de as f64 / dt).round(),
                        "kbps": ((bytes - prev.2) as f64 * 8.0 / 1000.0 / dt).round(),
                        "target_kbps": ctl.kbps.load(Ordering::Relaxed),
                        "encode_ms": if de > 0 { ((lat - prev.3) as f64 / de as f64 / 100.0).round() / 10.0 } else { 0.0 },
                    }));
                    prev = (cap, enc, bytes, lat);
                }
            }
            line = stdin.next_line() => {
                // EOF (the parent went away) or an explicit "stop".
                match line {
                    Ok(Some(l)) if l.trim() == "stop" => break,
                    Ok(Some(l)) => {
                        // "kbps N": the share panel's bitrate changed while live.
                        if let Some(v) = l.trim().strip_prefix("kbps ").and_then(|v| v.parse::<u32>().ok()) {
                            max_kbps = v.clamp(1500, 100_000);
                            ctl.kbps.store(max_kbps, Ordering::Relaxed);
                        }
                    }
                    _ => break,
                }
            }
            ev = events.recv() => {
                match ev {
                    Some(RoomEvent::Disconnected { reason }) => {
                        emit(json!({ "event": "disconnected", "reason": format!("{reason:?}") }));
                        break;
                    }
                    None => break,
                    _ => {}
                }
            }
        }
    }
    handle.stop()?;
    let _ = room.close().await;
    emit(json!({ "event": "stopped" }));
    Ok(())
}
