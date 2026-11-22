mod pipeline;
mod publish;
mod tuning;

use anyhow::{anyhow, Result};
use pipeline::{Config, Source};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

fn parse_args() -> (String, HashMap<String, String>) {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_default();
    let mut map = HashMap::new();
    while let Some(k) = it.next() {
        if let Some(k) = k.strip_prefix("--") {
            map.insert(k.to_string(), it.next().unwrap_or_default());
        }
    }
    (cmd, map)
}

fn config_from(args: &HashMap<String, String>) -> Result<Config> {
    let num = |k: &str, d: u32| args.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let source = if let Some(h) = args.get("hwnd") {
        Source::Window(h.parse::<isize>().map_err(|_| anyhow!("bad --hwnd"))?)
    } else if let Some(t) = args.get("window") {
        let h = pipeline::find_window(t).ok_or_else(|| anyhow!("window '{t}' not found"))?;
        Source::Window(h.0 as isize)
    } else if let Some(p) = args.get("point") {
        let (x, y) = p.split_once(',').ok_or_else(|| anyhow!("bad --point"))?;
        Source::Monitor { x: x.parse()?, y: y.parse()? }
    } else {
        Source::Monitor { x: 0, y: 0 }
    };
    Ok(Config { source, max_height: num("height", 0), fps: num("fps", 60), kbps: num("kbps", 8000) })
}

fn bench(args: HashMap<String, String>) -> Result<()> {
    let cfg = config_from(&args)?;
    let seconds: u64 = args.get("seconds").and_then(|v| v.parse().ok()).unwrap_or(10);
    let mut out = args.get("out").map(std::fs::File::create).transpose()?;
    let handle = pipeline::start(
        cfg.clone(),
        Box::new(move |f| {
            if let Some(o) = out.as_mut() {
                let _ = o.write_all(&f.data);
            }
        }),
    )?;
    println!("{}x{} @ {} fps, {} kbps, encoder: {}, tune: {}", handle.width, handle.height, cfg.fps, cfg.kbps, handle.encoder, tuning::describe(tuning::get()));
    println!("sec  cap  rate-drop  mbox-drop  enc  key  kbps  lat-avg  lat-max");
    let c = &handle.ctl.counters;
    let start = Instant::now();
    let (mut pc, mut pr, mut pm, mut pe, mut pk, mut pb, mut pl) = (0, 0, 0, 0, 0, 0, 0);
    while start.elapsed() < Duration::from_secs(seconds) {
        std::thread::sleep(Duration::from_secs(1));
        let (cap, rd, md, enc, key, bytes, lat) = (
            c.captured.load(Ordering::Relaxed),
            c.dropped_rate.load(Ordering::Relaxed),
            c.dropped_mailbox.load(Ordering::Relaxed),
            c.encoded.load(Ordering::Relaxed),
            c.keyframes.load(Ordering::Relaxed),
            c.bytes.load(Ordering::Relaxed),
            c.lat_us_sum.load(Ordering::Relaxed),
        );
        let de = enc - pe;
        println!(
            "{:>3}  {:>3}  {:>9}  {:>9}  {:>3}  {:>3}  {:>4}  {:>6.1}ms {:>6.1}ms",
            start.elapsed().as_secs(),
            cap - pc,
            rd - pr,
            md - pm,
            de,
            key - pk,
            (bytes - pb) * 8 / 1000,
            if de > 0 { (lat - pl) as f64 / de as f64 / 1000.0 } else { 0.0 },
            c.lat_us_max.swap(0, Ordering::Relaxed) as f64 / 1000.0,
        );
        (pc, pr, pm, pe, pk, pb, pl) = (cap, rd, md, enc, key, bytes, lat);
    }
    let total = c.encoded.load(Ordering::Relaxed);
    handle.stop()?;
    println!("TOTAL {seconds}s: encoded {total} => {:.1} fps", total as f64 / seconds as f64);
    Ok(())
}

fn main() -> Result<()> {
    let (cmd, args) = parse_args();
    tuning::apply_process();
    match cmd.as_str() {
        "bench" => bench(args),
        "publish" => {
            let cfg = config_from(&args)?;
            let url = args.get("url").cloned().ok_or_else(|| anyhow!("--url required"))?;
            let token = args.get("token").cloned().ok_or_else(|| anyhow!("--token required"))?;
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
            let r = rt.block_on(publish::run(cfg, url, token));
            if let Err(e) = &r {
                println!("{}", serde_json::json!({ "event": "error", "message": format!("{e:#}") }));
            }
            r
        }
        _ => Err(anyhow!(
            "usage: scrima-capture publish --url U --token T [capture args] | bench [--seconds N --fps N --kbps N --height H --window TITLE|--hwnd N|--point x,y --out file]"
        )),
    }
}
