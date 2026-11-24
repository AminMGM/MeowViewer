//! Windows Imaging Component: full-resolution decode of everything the WebView can't show
//! (HEIC/HEIF, TIFF, JPEG XR, DDS, RAW, JPEG XL/AVIF with the Store extensions…) and lossless
//! JPEG rotation by rewriting the EXIF orientation tag in place.

use std::mem::ManuallyDrop;
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VT_UI2;

fn factory() -> windows::core::Result<IWICImagingFactory> {
    crate::com_init();
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
}

fn transform_for(orientation: u16) -> WICBitmapTransformOptions {
    match orientation {
        2 => WICBitmapTransformFlipHorizontal,
        3 => WICBitmapTransformRotate180,
        4 => WICBitmapTransformFlipVertical,
        5 => WICBitmapTransformOptions(WICBitmapTransformRotate90.0 | WICBitmapTransformFlipHorizontal.0),
        6 => WICBitmapTransformRotate90,
        7 => WICBitmapTransformOptions(WICBitmapTransformRotate270.0 | WICBitmapTransformFlipHorizontal.0),
        8 => WICBitmapTransformRotate270,
        _ => WICBitmapTransformRotate0,
    }
}

/// Decodes the first frame to RGBA8, scaled so the longest side is at most `max_dim`,
/// with EXIF orientation applied.
pub fn decode_rgba(path: &str, max_dim: u32, orientation: u16) -> Result<(Vec<u8>, u32, u32), String> {
    let run = || -> windows::core::Result<(Vec<u8>, u32, u32)> {
        unsafe {
            let f = factory()?;
            let dec = f.CreateDecoderFromFilename(
                &HSTRING::from(path),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )?;
            let frame = dec.GetFrame(0)?;
            let mut src: IWICBitmapSource = frame.cast()?;
            let (mut w, mut h) = (0u32, 0u32);
            src.GetSize(&mut w, &mut h)?;
            let longest = w.max(h);
            if longest > max_dim && max_dim > 0 {
                let s = max_dim as f64 / longest as f64;
                let (nw, nh) = (((w as f64) * s).round().max(1.0) as u32, ((h as f64) * s).round().max(1.0) as u32);
                let scaler = f.CreateBitmapScaler()?;
                scaler.Initialize(&src, nw, nh, WICBitmapInterpolationModeHighQualityCubic)?;
                src = scaler.cast()?;
            }
            if orientation > 1 && orientation <= 8 {
                let rot = f.CreateBitmapFlipRotator()?;
                rot.Initialize(&src, transform_for(orientation))?;
                src = rot.cast()?;
            }
            let conv = f.CreateFormatConverter()?;
            conv.Initialize(
                &src,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            conv.GetSize(&mut w, &mut h)?;
            let stride = w * 4;
            let mut buf = vec![0u8; (stride * h) as usize];
            conv.CopyPixels(std::ptr::null(), stride, &mut buf)?;
            Ok((buf, w, h))
        }
    };
    run().map_err(|e| e.message())
}

/// Full-res decode → JPEG (or PNG when the image has transparency) for the viewer.
pub fn decode_for_view(path: &str, max_dim: u32, orientation: u16) -> Result<(Vec<u8>, &'static str), String> {
    let (rgba, w, h) = decode_rgba(path, max_dim, orientation)?;
    let has_alpha = rgba.chunks_exact(4).any(|p| p[3] != 255);
    let mut out = Vec::new();
    if has_alpha {
        image::codecs::png::PngEncoder::new_with_quality(
            &mut out,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Sub,
        )
        .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
        Ok((out, "image/png"))
    } else {
        let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92)
            .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
        Ok((out, "image/jpeg"))
    }
}

use image::ImageEncoder;

/// Encodes RGBA as a 24-bit BMP file (for the clipboard).
pub fn rgba_to_bmp(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let rgb: Vec<u8> = rgba.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    let mut out = Vec::new();
    image::codecs::bmp::BmpEncoder::new(&mut out)
        .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Rotates clockwise by `quarters` × 90° without touching pixel data, by updating the EXIF
/// orientation tag in place (what Windows Photos/Explorer do). Fails if the file has no
/// orientation tag/padding to write into.
pub fn rotate_lossless(path: &str, current: u16, quarters: i32) -> Result<u16, String> {
    // Orientation cycles for clockwise rotation: plain and mirrored families.
    const PLAIN: [u16; 4] = [1, 6, 3, 8];
    const MIRROR: [u16; 4] = [2, 7, 4, 5];
    let q = quarters.rem_euclid(4) as usize;
    let next = if let Some(i) = PLAIN.iter().position(|&o| o == current) {
        PLAIN[(i + q) % 4]
    } else if let Some(i) = MIRROR.iter().position(|&o| o == current) {
        MIRROR[(i + q) % 4]
    } else {
        PLAIN[q]
    };
    let ext = crate::media::ext_of(path);
    let query = match ext.as_str() {
        "jpg" | "jpeg" | "jfif" | "jpe" => "/app1/ifd/{ushort=274}",
        "tif" | "tiff" => "/ifd/{ushort=274}",
        _ => return Err("Lossless rotation is only available for JPEG and TIFF".into()),
    };
    let run = || -> windows::core::Result<()> {
        unsafe {
            let f = factory()?;
            let dec = f.CreateDecoderFromFilename(
                &HSTRING::from(path),
                None,
                GENERIC_READ | GENERIC_WRITE,
                WICDecodeMetadataCacheOnDemand,
            )?;
            let frame = dec.GetFrame(0)?;
            let enc = f.CreateFastMetadataEncoderFromFrameDecode(&frame)?;
            let writer = enc.GetMetadataQueryWriter()?;
            let mut pv = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_UI2,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous: PROPVARIANT_0_0_0 { uiVal: next },
                    }),
                },
            };
            let q = HSTRING::from(query);
            let r = writer.SetMetadataByName(PCWSTR(q.as_ptr()), &pv);
            let _ = PropVariantClear(&mut pv);
            r?;
            enc.Commit()?;
            Ok(())
        }
    };
    run().map_err(|e| e.message())?;
    Ok(next)
}
