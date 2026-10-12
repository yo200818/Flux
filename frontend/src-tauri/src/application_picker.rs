#[cfg(windows)]
pub fn select_executable() -> Result<Option<String>, String> {
    use std::mem::size_of;
    use std::path::Path;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    let filter: Vec<u16> = "Applications (*.exe)\0*.exe\0All files (*.*)\0*.*\0\0"
        .encode_utf16()
        .collect();
    let title: Vec<u16> = "Select an application executable\0"
        .encode_utf16()
        .collect();
    let mut file_buffer = vec![0_u16; 32_768];
    let mut dialog = OPENFILENAMEW {
        lStructSize: size_of::<OPENFILENAMEW>() as u32,
        lpstrFilter: filter.as_ptr(),
        nFilterIndex: 1,
        lpstrFile: file_buffer.as_mut_ptr(),
        nMaxFile: file_buffer.len() as u32,
        lpstrTitle: title.as_ptr(),
        Flags: OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR,
        ..Default::default()
    };

    let selected = unsafe { GetOpenFileNameW(&mut dialog) };
    if selected == 0 {
        let error_code = unsafe { CommDlgExtendedError() };
        if error_code == 0 {
            return Ok(None);
        }
        return Err(format!(
            "Windows could not open the application picker (dialog error {error_code})."
        ));
    }

    let end = file_buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(file_buffer.len());
    let selected_path = String::from_utf16_lossy(&file_buffer[..end]);
    let path = Path::new(&selected_path);
    if !path.is_absolute()
        || !path.is_file()
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err("Choose an existing Windows .exe application file.".to_string());
    }
    Ok(Some(selected_path))
}

#[cfg(not(windows))]
pub fn select_executable() -> Result<Option<String>, String> {
    Err("The native application picker is only available in the Windows desktop app.".to_string())
}
