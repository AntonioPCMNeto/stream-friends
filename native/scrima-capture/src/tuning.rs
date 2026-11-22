// Scheduling knobs for a capture helper that runs next to a game. SCRIMA_TUNE
// (comma list) overrides the defaults for A/B runs: cpu=normal|above|high,
// timer=0|1, gpu=none|high|realtime, mmcss=none|Games|Capture|Pro Audio.

use std::cell::Cell;
use std::sync::OnceLock;
use windows::core::{s, w, PCWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Media::timeBeginPeriod;
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
use windows::Win32::System::Threading::{
    AvSetMmThreadCharacteristicsW, GetCurrentProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS,
    HIGH_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
};

pub struct Tune {
    pub cpu: String,
    pub timer: bool,
    pub gpu: String,
    pub mmcss: String,
}

pub fn get() -> &'static Tune {
    static T: OnceLock<Tune> = OnceLock::new();
    T.get_or_init(from_env)
}

fn from_env() -> Tune {
    let mut t = Tune { cpu: "above".into(), timer: true, gpu: "high".into(), mmcss: "Games".into() };
    if let Ok(v) = std::env::var("SCRIMA_TUNE") {
        for kv in v.split(',') {
            match kv.split_once('=') {
                Some(("cpu", x)) => t.cpu = x.into(),
                Some(("timer", x)) => t.timer = x == "1",
                Some(("gpu", x)) => t.gpu = x.into(),
                Some(("mmcss", x)) => t.mmcss = x.into(),
                _ => {}
            }
        }
    }
    t
}

pub fn describe(t: &Tune) -> String {
    format!("cpu={} timer={} gpu={} mmcss={} ", t.cpu, t.timer as u8, t.gpu, t.mmcss)
}

/// Process-wide: CPU priority class (a child of the Electron main process
/// inherits BELOW_NORMAL, so this also undoes that), 1 ms timers, and the GPU
/// scheduling class the way OBS and Sunshine do.
pub fn apply_process() {
    let t = get();
    unsafe {
        let class = match t.cpu.as_str() {
            "high" => Some(HIGH_PRIORITY_CLASS),
            "above" => Some(ABOVE_NORMAL_PRIORITY_CLASS),
            "normal" => Some(NORMAL_PRIORITY_CLASS),
            _ => None,
        };
        if let Some(c) = class {
            let _ = SetPriorityClass(GetCurrentProcess(), c);
        }
        if t.timer {
            timeBeginPeriod(1);
        }
        let level = match t.gpu.as_str() {
            "high" => 4,
            "realtime" => 5,
            _ => 0,
        };
        if level != 0 {
            let module = GetModuleHandleW(w!("gdi32.dll")).or_else(|_| LoadLibraryW(w!("gdi32.dll")));
            if let Ok(m) = module {
                if let Some(f) = GetProcAddress(m, s!("D3DKMTSetProcessSchedulingPriorityClass")) {
                    let f: unsafe extern "system" fn(HANDLE, i32) -> i32 = std::mem::transmute(f);
                    let status = f(GetCurrentProcess(), level);
                    if status != 0 {
                        eprintln!("gpu priority class {} rejected: 0x{:08x}", t.gpu, status as u32);
                    }
                }
            }
        }
    }
}

thread_local! { static BOOSTED: Cell<bool> = const { Cell::new(false) }; }

/// Registers the calling thread with MMCSS once.
pub fn boost_thread() {
    let t = get();
    if t.mmcss == "none" || BOOSTED.with(|b| b.replace(true)) {
        return;
    }
    let name: Vec<u16> = t.mmcss.encode_utf16().chain(std::iter::once(0)).collect();
    let mut index = 0u32;
    unsafe {
        if let Err(e) = AvSetMmThreadCharacteristicsW(PCWSTR(name.as_ptr()), &mut index) {
            eprintln!("mmcss {} rejected: {e}", t.mmcss);
        }
    }
}
