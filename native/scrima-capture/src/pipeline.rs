// Windows Graphics Capture -> D3D11 video processor (BGRA -> NV12 on the GPU,
// scaled and tagged BT.709) -> hardware H.264 Media Foundation encoder.
// Frames come out as Annex-B access units (AUD, SPS/PPS before every IDR).

use anyhow::{anyhow, Result};
use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use windows::core::{factory, Interface, VARIANT};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{BOOL, HMODULE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};

const POOL: usize = 8;

fn pack(a: &IMFAttributes, key: &windows::core::GUID, hi: u32, lo: u32) -> windows::core::Result<()> {
    unsafe { a.SetUINT64(key, ((hi as u64) << 32) | lo as u64) }
}

struct SendBox<T>(T);
unsafe impl<T> Send for SendBox<T> {}
impl<T> SendBox<T> {
    fn get(&self) -> &T {
        &self.0
    }
}

#[derive(Clone, Debug)]
pub enum Source {
    /// The monitor containing this point (virtual-desktop pixels).
    Monitor { x: i32, y: i32 },
    Window(isize),
}

#[derive(Clone, Debug)]
pub struct Config {
    pub source: Source,
    /// 0 keeps the capture height; otherwise the output is scaled to this
    /// height (aspect kept, never upscaled).
    pub max_height: u32,
    pub fps: u32,
    pub kbps: u32,
}

pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub ts_us: i64,
    pub key: bool,
}

#[derive(Default)]
pub struct Counters {
    pub captured: AtomicU64,
    pub dropped_rate: AtomicU64,
    pub dropped_mailbox: AtomicU64,
    pub encoded: AtomicU64,
    pub keyframes: AtomicU64,
    pub bytes: AtomicU64,
    pub lat_us_sum: AtomicU64,
    pub lat_us_max: AtomicU64,
}

pub struct Ctl {
    pub stop: AtomicBool,
    pub force_key: AtomicBool,
    pub kbps: AtomicU32,
    pub counters: Counters,
}

pub struct Handle {
    pub ctl: Arc<Ctl>,
    pub width: u32,
    pub height: u32,
    pub encoder: String,
    thread: Option<std::thread::JoinHandle<Result<()>>>,
}

impl Handle {
    pub fn stop(mut self) -> Result<()> {
        self.ctl.stop.store(true, Ordering::Relaxed);
        match self.thread.take() {
            Some(t) => t.join().map_err(|_| anyhow!("pipeline thread panicked"))?,
            None => Ok(()),
        }
    }
}

struct Frame {
    tex: usize,
    ts: i64,
    at: Instant,
}

pub fn find_window(needle: &str) -> Option<HWND> {
    struct Ctx {
        needle: String,
        found: Option<HWND>,
    }
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> BOOL {
        let ctx = &mut *(l.0 as *mut Ctx);
        if IsWindowVisible(h).as_bool() {
            let mut buf = [0u16; 256];
            let n = GetWindowTextW(h, &mut buf) as usize;
            if String::from_utf16_lossy(&buf[..n]).to_lowercase().contains(&ctx.needle) {
                ctx.found = Some(h);
                return false.into();
            }
        }
        true.into()
    }
    let mut ctx = Ctx { needle: needle.to_lowercase(), found: None };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.found
}

fn capture_item(source: &Source) -> Result<GraphicsCaptureItem> {
    unsafe {
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        Ok(match source {
            Source::Monitor { x, y } => {
                let hmon = MonitorFromPoint(POINT { x: *x, y: *y }, MONITOR_DEFAULTTOPRIMARY);
                interop.CreateForMonitor(hmon)?
            }
            Source::Window(h) => interop.CreateForWindow(HWND(*h as *mut _))?,
        })
    }
}

fn even(v: u32) -> u32 {
    (v & !1).max(2)
}

/// The encode size for a capture of `cw` x `ch`.
fn output_size(cw: u32, ch: u32, max_height: u32) -> (u32, u32) {
    if max_height == 0 || ch <= max_height {
        return (even(cw), even(ch));
    }
    let h = even(max_height);
    let w = even((cw as u64 * h as u64 / ch as u64) as u32);
    (w, h)
}

pub fn probe_size(cfg: &Config) -> Result<(u32, u32)> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let size = capture_item(&cfg.source)?.Size()?;
    Ok(output_size(size.Width as u32, size.Height as u32, cfg.max_height))
}

pub fn start(cfg: Config, sink: Box<dyn FnMut(EncodedFrame) + Send>) -> Result<Handle> {
    let ctl = Arc::new(Ctl {
        stop: AtomicBool::new(false),
        force_key: AtomicBool::new(true),
        kbps: AtomicU32::new(cfg.kbps),
        counters: Counters::default(),
    });
    let (tx, rx) = std::sync::mpsc::channel::<Result<(u32, u32, String)>>();
    let ctl2 = ctl.clone();
    let thread = std::thread::Builder::new().name("scrima-pipeline".into()).spawn(move || {
        let tx2 = tx.clone();
        let r = unsafe { run(cfg, sink, ctl2, tx) };
        if let Err(e) = &r {
            let _ = tx2.send(Err(anyhow!("{e:#}")));
        }
        r
    })?;
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok((width, height, encoder))) => Ok(Handle { ctl, width, height, encoder, thread: Some(thread) }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(anyhow!("pipeline did not start in time")),
    }
}

unsafe fn run(
    cfg: Config,
    mut sink: Box<dyn FnMut(EncodedFrame) + Send>,
    ctl: Arc<Ctl>,
    ready: std::sync::mpsc::Sender<Result<(u32, u32, String)>>,
) -> Result<()> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let _ = RoInitialize(RO_INIT_MULTITHREADED);
    MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
    let fps = cfg.fps.clamp(1, 120);

    // ---- D3D11 device
    let mut device: Option<ID3D11Device> = None;
    let mut ctx: Option<ID3D11DeviceContext> = None;
    D3D11CreateDevice(
        None,
        D3D_DRIVER_TYPE_HARDWARE,
        HMODULE::default(),
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        None,
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        Some(&mut ctx),
    )?;
    let device = device.ok_or_else(|| anyhow!("no d3d11 device"))?;
    let ctx = ctx.ok_or_else(|| anyhow!("no d3d11 context"))?;
    let _ = device.cast::<ID3D11Multithread>()?.SetMultithreadProtected(true);

    // ---- capture
    let item = capture_item(&cfg.source)?;
    let size = item.Size()?;
    let (w, h) = output_size(size.Width as u32, size.Height as u32, cfg.max_height);

    let dxgi: IDXGIDevice = device.cast()?;
    let _ = dxgi.SetGPUThreadPriority(7);
    let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?;
    let winrt_dev: IDirect3DDevice = inspectable.cast()?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_dev,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        4,
        size,
    )?;
    let session = pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsCursorCaptureEnabled(true);
    let _ = session.SetIsBorderRequired(false);
    let _ = session.SetMinUpdateInterval(windows::Foundation::TimeSpan { Duration: 10_000_000 / 240 });

    // ---- GPU BGRA -> NV12
    let vdev: ID3D11VideoDevice = device.cast()?;
    let vctx: ID3D11VideoContext = ctx.cast()?;
    let cdesc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
        InputWidth: size.Width as u32,
        InputHeight: size.Height as u32,
        OutputFrameRate: DXGI_RATIONAL { Numerator: fps, Denominator: 1 },
        OutputWidth: w,
        OutputHeight: h,
        Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    };
    let venum = vdev.CreateVideoProcessorEnumerator(&cdesc)?;
    let vp = vdev.CreateVideoProcessor(&venum, 0)?;
    // Input: full-range RGB. Output: BT.709, limited range (matches the tags
    // written on the encoder's input type, so players decode the same colors).
    let cs_in = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 };
    let cs_out = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: (1 << 2) | (1 << 4) };
    vctx.VideoProcessorSetStreamColorSpace(&vp, 0, &cs_in);
    vctx.VideoProcessorSetOutputColorSpace(&vp, &cs_out);

    let mut nv12: Vec<ID3D11Texture2D> = Vec::new();
    let mut nv12_views: Vec<ID3D11VideoProcessorOutputView> = Vec::new();
    for _ in 0..POOL {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        device.CreateTexture2D(&desc, None, Some(&mut tex))?;
        let tex = tex.ok_or_else(|| anyhow!("nv12 texture"))?;
        let odesc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
            },
        };
        let mut view: Option<ID3D11VideoProcessorOutputView> = None;
        vdev.CreateVideoProcessorOutputView(&tex, &venum, &odesc, Some(&mut view))?;
        nv12.push(tex);
        nv12_views.push(view.ok_or_else(|| anyhow!("nv12 view"))?);
    }

    // ---- hardware H.264 MFT
    let mut token = 0u32;
    let mut mgr: Option<IMFDXGIDeviceManager> = None;
    MFCreateDXGIDeviceManager(&mut token, &mut mgr)?;
    let mgr = mgr.ok_or_else(|| anyhow!("dxgi manager"))?;
    mgr.ResetDevice(&device, token)?;

    let mut acts: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    let out_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
        None,
        Some(&out_info),
        &mut acts,
        &mut count,
    )?;
    if count == 0 {
        return Err(anyhow!("no hardware H.264 encoder MFT"));
    }
    let list = std::slice::from_raw_parts(acts, count as usize);
    let act = list[0].clone().ok_or_else(|| anyhow!("activate"))?;
    let mut name = [0u16; 128];
    let mut name_len = 0u32;
    let _ = act.GetString(&MFT_FRIENDLY_NAME_Attribute, &mut name, Some(&mut name_len));
    let encoder_name = String::from_utf16_lossy(&name[..name_len as usize]);
    let transform: IMFTransform = act.ActivateObject()?;
    for a in list.iter() {
        drop(a.clone());
    }
    CoTaskMemFree(Some(acts as *const _));

    let attrs = transform.GetAttributes()?;
    attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, mgr.as_raw() as usize)?;

    let kbps = cfg.kbps.max(500);
    // This encoder sizes frames as if the stream ran at 30 fps (measured: at 60 fps
    // it emits ~2.1x the requested rate), so above 30 fps the parameter is scaled down.
    let enc_kbps = move |k: u32| -> u32 { ((k as f64 * 30.0 / fps.max(30) as f64).round() as u32).max(300) };
    let otype = MFCreateMediaType()?;
    otype.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
    otype.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
    otype.SetUINT32(&MF_MT_AVG_BITRATE, enc_kbps(kbps) * 1000)?;
    pack(&otype, &MF_MT_FRAME_SIZE, w, h)?;
    pack(&otype, &MF_MT_FRAME_RATE, fps, 1)?;
    pack(&otype, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
    otype.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    otype.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
    let _ = otype.SetUINT32(&MF_MT_MPEG2_LEVEL, if w * h > 1920 * 1088 { 51 } else if fps > 30 { 42 } else { 40 });
    transform.SetOutputType(0, &otype, 0)?;

    let itype = MFCreateMediaType()?;
    itype.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
    itype.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
    pack(&itype, &MF_MT_FRAME_SIZE, w, h)?;
    pack(&itype, &MF_MT_FRAME_RATE, fps, 1)?;
    pack(&itype, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
    itype.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    let _ = itype.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32);
    let _ = itype.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32);
    let _ = itype.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32);
    let _ = itype.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32);
    transform.SetInputType(0, &itype, 0)?;

    let api: ICodecAPI = transform.cast()?;
    let set = |key: &windows::core::GUID, v: VARIANT, label: &str| {
        if let Err(e) = api.SetValue(key, &v) {
            eprintln!("codec api {label} rejected: {e}");
        }
    };
    set(&CODECAPI_AVLowLatencyMode, VARIANT::from(true), "low-latency");
    // Peak-constrained VBR: this encoder sizes CBR frames as if the stream
    // were 30 fps and overshoots ~2x at 60; VBR with a hard peak holds the cap.
    set(&CODECAPI_AVEncCommonRateControlMode, VARIANT::from(eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32), "rate-control");
    set(&CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(enc_kbps(kbps) * 1000), "bitrate");
    set(&CODECAPI_AVEncCommonMaxBitRate, VARIANT::from(enc_kbps(kbps) * 1100), "max-bitrate");
    set(&CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0u32), "no B-frames");
    set(&CODECAPI_AVEncMPVGOPSize, VARIANT::from(fps * 10), "GOP");
    set(&CODECAPI_AVEncCommonQualityVsSpeed, VARIANT::from(35u32), "quality-vs-speed");

    transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
    transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
    transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

    // ---- capture callback: scale/convert on the GPU, hand over the newest frame
    let mailbox: Arc<(Mutex<Option<Frame>>, Condvar)> = Arc::new((Mutex::new(None), Condvar::new()));
    let next_tex = Arc::new(AtomicUsize::new(0));
    let next_ts = Arc::new(Mutex::new(i64::MIN));
    let last_size = Arc::new(Mutex::new((size.Width, size.Height)));
    let interval = 10_000_000i64 / fps as i64;
    let handler = {
        let ctl = ctl.clone();
        let mailbox = mailbox.clone();
        let nv12_views = nv12_views.clone();
        let vctx = vctx.clone();
        let vdev = vdev.clone();
        let venum = venum.clone();
        let vp = vp.clone();
        let winrt_box = SendBox(winrt_dev.clone());
        TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(move |p, _| {
            let Some(p) = p.as_ref() else { return Ok(()) };
            let Ok(frame) = p.TryGetNextFrame() else { return Ok(()) };
            let ts = frame.SystemRelativeTime()?.Duration;
            ctl.counters.captured.fetch_add(1, Ordering::Relaxed);
            {
                let mut next = next_ts.lock().unwrap();
                if *next == i64::MIN {
                    *next = ts;
                }
                if ts < *next - interval / 4 {
                    ctl.counters.dropped_rate.fetch_add(1, Ordering::Relaxed);
                    return Ok(());
                }
                *next += interval;
                if ts - *next > interval * 2 {
                    *next = ts + interval;
                }
            }
            let content = frame.ContentSize()?;
            {
                // A resized window: the pool's buffers are the old size.
                let mut last = last_size.lock().unwrap();
                if (content.Width, content.Height) != *last && content.Width > 0 && content.Height > 0 {
                    *last = (content.Width, content.Height);
                    let _ = p.Recreate(winrt_box.get(), DirectXPixelFormat::B8G8R8A8UIntNormalized, 4, content);
                }
            }
            let surface = frame.Surface()?;
            let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
            let src: ID3D11Texture2D = access.GetInterface()?;
            let idx = next_tex.fetch_add(1, Ordering::Relaxed) % POOL;
            let idesc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 },
                },
            };
            let mut iv: Option<ID3D11VideoProcessorInputView> = None;
            unsafe {
                vdev.CreateVideoProcessorInputView(&src, &venum, &idesc, Some(&mut iv))?;
                let rect = RECT { left: 0, top: 0, right: content.Width, bottom: content.Height };
                vctx.VideoProcessorSetStreamSourceRect(&vp, 0, true, Some(&rect));
                let stream = D3D11_VIDEO_PROCESSOR_STREAM {
                    Enable: true.into(),
                    pInputSurface: ManuallyDrop::new(iv),
                    ..Default::default()
                };
                vctx.VideoProcessorBlt(&vp, &nv12_views[idx], 0, &[stream])?;
            }
            let (m, cv) = &*mailbox;
            let mut g = m.lock().unwrap();
            if g.is_some() {
                ctl.counters.dropped_mailbox.fetch_add(1, Ordering::Relaxed);
            }
            *g = Some(Frame { tex: idx, ts, at: Instant::now() });
            cv.notify_one();
            Ok(())
        })
    };
    pool.FrameArrived(&handler)?;
    session.StartCapture()?;
    let _ = ready.send(Ok((w, h, encoder_name)));

    // ---- encoder loop (this thread)
    let events: IMFMediaEventGenerator = transform.cast()?;
    let info = transform.GetOutputStreamInfo(0)?;
    let provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
    let mut credits = 0u32;
    let mut inflight: VecDeque<(i64, Instant)> = VecDeque::new();
    let frame_dur = 10_000_000i64 / fps as i64;
    let mut cur_kbps = kbps;
    let result: Result<()> = (|| {
        while !ctl.stop.load(Ordering::Relaxed) {
            if ctl.force_key.swap(false, Ordering::Relaxed) {
                let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
            }
            let want = ctl.kbps.load(Ordering::Relaxed).clamp(300, 100_000);
            if want != cur_kbps {
                cur_kbps = want;
                let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(enc_kbps(want) * 1000));
                let _ = api.SetValue(&CODECAPI_AVEncCommonMaxBitRate, &VARIANT::from(enc_kbps(want) * 1100));
            }
            if credits > 0 {
                let f = mailbox.0.lock().unwrap().take();
                if let Some(f) = f {
                    let buf = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &nv12[f.tex], 0, false)?;
                    if let Ok(b2) = buf.cast::<IMF2DBuffer>() {
                        if let Ok(len) = b2.GetContiguousLength() {
                            let _ = buf.SetCurrentLength(len);
                        }
                    }
                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&buf)?;
                    sample.SetSampleTime(f.ts)?;
                    sample.SetSampleDuration(frame_dur)?;
                    transform.ProcessInput(0, &sample, 0)?;
                    inflight.push_back((f.ts, f.at));
                    credits -= 1;
                    continue;
                }
            }
            match events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                Ok(ev) => {
                    let t = ev.GetType()?;
                    if t == METransformNeedInput.0 as u32 {
                        credits += 1;
                    } else if t == METransformHaveOutput.0 as u32 {
                        let mut data = [MFT_OUTPUT_DATA_BUFFER::default()];
                        if !provides {
                            let s = MFCreateSample()?;
                            let b = MFCreateMemoryBuffer(info.cbSize.max(1 << 20))?;
                            s.AddBuffer(&b)?;
                            data[0].pSample = ManuallyDrop::new(Some(s));
                        }
                        let mut status = 0u32;
                        transform.ProcessOutput(0, &mut data, &mut status)?;
                        if let Some(sample) = ManuallyDrop::into_inner(std::mem::take(&mut data[0].pSample)) {
                            let cb = sample.ConvertToContiguousBuffer()?;
                            let mut p: *mut u8 = std::ptr::null_mut();
                            let mut len = 0u32;
                            cb.Lock(&mut p, None, Some(&mut len))?;
                            let bytes = std::slice::from_raw_parts(p, len as usize).to_vec();
                            cb.Unlock()?;
                            let key = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1;
                            let ts = sample.GetSampleTime().unwrap_or(0);
                            let lat_us = inflight
                                .iter()
                                .position(|(t, _)| *t == ts)
                                .map(|i| inflight.remove(i).unwrap().1.elapsed().as_micros() as u64)
                                .unwrap_or(0);
                            while inflight.len() > 16 {
                                inflight.pop_front();
                            }
                            let c = &ctl.counters;
                            c.encoded.fetch_add(1, Ordering::Relaxed);
                            c.bytes.fetch_add(len as u64, Ordering::Relaxed);
                            c.keyframes.fetch_add(key as u64, Ordering::Relaxed);
                            c.lat_us_sum.fetch_add(lat_us, Ordering::Relaxed);
                            c.lat_us_max.fetch_max(lat_us, Ordering::Relaxed);
                            sink(EncodedFrame { data: bytes, ts_us: ts / 10, key });
                        }
                    }
                }
                Err(_) => {
                    let (m, cv) = &*mailbox;
                    let g = m.lock().unwrap();
                    let _ = cv.wait_timeout(g, Duration::from_millis(1));
                }
            }
        }
        Ok(())
    })();

    let _ = session.Close();
    let _ = pool.Close();
    let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    let _ = transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    result
}
