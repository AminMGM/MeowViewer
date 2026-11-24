//! Windows Property System: video dimensions, duration, frame rate, bitrate.
//! Uses the same handlers Explorer uses, so it works for every container Windows knows.

use windows::core::HSTRING;
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Storage::EnhancedStorage::*;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToUInt32, PropVariantToUInt64};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreFromParsingName, GPS_DEFAULT};

fn store(path: &str) -> Option<IPropertyStore> {
    crate::com_init();
    unsafe { SHGetPropertyStoreFromParsingName(&HSTRING::from(path), None, GPS_DEFAULT).ok() }
}

fn get_u64(s: &IPropertyStore, key: &PROPERTYKEY) -> Option<u64> {
    unsafe {
        let mut v = s.GetValue(key).ok()?;
        let r = PropVariantToUInt64(&v).ok().or_else(|| PropVariantToUInt32(&v).ok().map(u64::from));
        let _ = PropVariantClear(&mut v);
        r.filter(|x| *x > 0)
    }
}

pub fn dimensions(path: &str) -> Option<(u32, u32)> {
    let s = store(path)?;
    let w = get_u64(&s, &PKEY_Video_FrameWidth).or_else(|| get_u64(&s, &PKEY_Image_HorizontalSize))?;
    let h = get_u64(&s, &PKEY_Video_FrameHeight).or_else(|| get_u64(&s, &PKEY_Image_VerticalSize))?;
    Some((w as u32, h as u32))
}

pub fn video_fields(path: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(s) = store(path) else { return out };
    if let Some(d) = get_u64(&s, &PKEY_Media_Duration) {
        let secs = d / 10_000_000;
        out.push(("Duration".into(), format!("{}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60)));
    }
    if let Some(fr) = get_u64(&s, &PKEY_Video_FrameRate) {
        out.push(("Frame rate".into(), format!("{:.2} fps", fr as f64 / 1000.0)));
    }
    if let Some(br) = get_u64(&s, &PKEY_Video_TotalBitrate).or_else(|| get_u64(&s, &PKEY_Video_EncodingBitrate)) {
        out.push(("Bitrate".into(), format!("{:.1} Mbps", br as f64 / 1_000_000.0)));
    }
    if let Some(ch) = get_u64(&s, &PKEY_Audio_ChannelCount) {
        out.push(("Audio channels".into(), ch.to_string()));
    }
    if let Some(sr) = get_u64(&s, &PKEY_Audio_SampleRate) {
        out.push(("Audio sample rate".into(), format!("{:.1} kHz", sr as f64 / 1000.0)));
    }
    out
}
