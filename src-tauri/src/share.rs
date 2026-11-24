//! Windows share sheet (Nearby Share, Phone Link, Mail, WhatsApp, Telegram Store app, Quick Share…).

use std::cell::RefCell;
use windows::core::{Interface, HSTRING};
use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
use windows::Foundation::TypedEventHandler;
use windows::Storage::{IStorageItem, StorageFile};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::IDataTransferManagerInterop;
use windows_collections::IIterable;

thread_local! {
    // The handler registered for the previous share, removed before registering a new one.
    static PREVIOUS: RefCell<Option<(DataTransferManager, i64)>> = const { RefCell::new(None) };
}

/// Resolves StorageFiles (blocking; call off the UI thread).
pub fn storage_files(paths: &[String]) -> Result<Vec<StorageFile>, String> {
    crate::com_init();
    paths
        .iter()
        .map(|p| {
            StorageFile::GetFileFromPathAsync(&HSTRING::from(p.as_str()))
                .and_then(|op| op.join())
                .map_err(|e| format!("{p}: {}", e.message()))
        })
        .collect()
}

/// Shows the share sheet. Must run on the window's UI thread.
pub fn show(hwnd: HWND, files: Vec<StorageFile>, title: String) -> Result<(), String> {
    let run = || -> windows::core::Result<()> {
        let interop = windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>()?;
        let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
        PREVIOUS.with(|p| {
            if let Some((m, t)) = p.borrow_mut().take() {
                let _ = m.RemoveDataRequested(t);
            }
        });
        let items: Vec<Option<IStorageItem>> = files.iter().filter_map(|f| f.cast::<IStorageItem>().ok()).map(Some).collect();
        let items = crate::SendBox(IIterable::<IStorageItem>::from(items));
        let token = dtm.DataRequested(&TypedEventHandler::new(
            move |_, args: windows::core::Ref<DataRequestedEventArgs>| {
                let items = &items; // capture the whole SendBox, not just its field
                if let Some(args) = args.as_ref() {
                    let data = args.Request()?.Data()?;
                    data.Properties()?.SetTitle(&HSTRING::from(title.as_str()))?;
                    data.SetStorageItemsReadOnly(&items.0)?;
                }
                Ok(())
            },
        ))?;
        PREVIOUS.with(|p| *p.borrow_mut() = Some((dtm.clone(), token)));
        unsafe { interop.ShowShareUIForWindow(hwnd) }
    };
    run().map_err(|e| e.message())
}
